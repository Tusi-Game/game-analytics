/**
 * Default step-7 / step-8 hooks for 002's generic path.
 *
 * Step 7 (durable-immediate): a GENERIC event has NO durable-immediate work
 * (Q1 — no spine seed). {@link NoopDurableImmediateHook} just mints the ordering
 * token so the pipeline stays uniform; 003/005/006 override with real
 * first_seen / bitmap / money writes.
 *
 * Step 8 (hot updates): {@link GenericHotUpdateHook} does the generic cat + cnt
 * + rank hot writes via rehydrate-on-miss and marks the touched buckets dirty
 * for the flusher. Quarantined records never reach step 8 (the orchestrator
 * stops earlier), so this hook only ever runs for routed, deduped, mutable-day
 * records.
 *
 * The precise Redis increment commands (HINCRBY on cnt, HSET-max/min on cat,
 * ZINCRBY on rank) and the durable FLOOR read for rehydrate are Unit 3's to wire
 * to the real hot path; this hook establishes the SEAM and the ordering, and
 * performs the rehydrate + dirty-mark that the flush engine depends on.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { EventEnvelope, EventKind } from '../../common/contracts/envelope';
import type { RoutedRecord } from '../../common/contracts/queue-jobs';
import { RehydrateService, DurableFloor } from '../../common/redis-keys/rehydrate';
import { IngestKeys } from '../../common/redis-keys/redis-keys';
import { DirtyRegistry } from '../flush/dirty-registry';
import {
  DedupPassedToken,
  DurableImmediateHook,
  DurableWrittenToken,
  HotUpdatedToken,
  HotUpdateHook,
  SealCheckedToken,
} from './pipeline-steps';
import type { NameCapGate, PiiScrubPort, TypedValidator } from './ingest-kernel';
import { HotBucketWriter } from './hot-bucket.writer';
import { GameConfigService, GAME_CONFIG_DEFAULTS } from '../../config/game-config.service';

/** Generic events have no durable-immediate work (Q1). Mints the token only. */
@Injectable()
export class NoopDurableImmediateHook implements DurableImmediateHook {
  async write(_record: RoutedRecord, _sealChecked: SealCheckedToken): Promise<DurableWrittenToken> {
    return {} as DurableWrittenToken;
  }
}

/**
 * Supplies the durable Postgres FLOOR for a bucket about to be rehydrated. Unit
 * 3 wires this to a repository read (last-flushed absolute); the default seeds
 * from an empty floor so tests run without Postgres. Seeding from an empty floor
 * is only safe because HSETNX + the seeded marker make a later re-seed from the
 * real floor idempotent — but Unit 3 MUST supply the real floor in production.
 */
export interface FloorProvider {
  cntFloor(gameId: string, utcDay: string): Promise<DurableFloor>;
  catFloor(gameId: string, eventName: string): Promise<DurableFloor>;
  /** Durable floor for the `{game_id}:cnt:{utc_day}:exc` tally hash (per reason). */
  excFloor(gameId: string, utcDay: string): Promise<DurableFloor>;
}

/**
 * ============ Stage-C EXTENSION POINT: per-domain floor providers =========
 * This {@link FloorProvider} is the 002 GENERIC floor (cnt/cat/exc), consumed
 * ONLY by {@link GenericHotUpdateHook}. A typed story (003/004/006) needs floors
 * for its OWN domains (eco/bal/sess/act/ret/mon/payer …) so its rehydrate seeds
 * from the durable absolute, never 0.
 *
 * DELIBERATELY NOT a shared interface to extend. Forcing every story to add
 * `ecoFloor/sessFloor/monFloor …` methods here — and to `PostgresFloorProvider`
 * — would be the exact single-file collision the kind-dispatch seam exists to
 * avoid. Instead each story's registered step-8 hot hook (via
 * `KIND_HOT_REGISTRATION`) INJECTS ITS OWN floor provider, scoped to its domains,
 * and calls it directly inside the story hook body. The generic floor here is
 * never touched by a story, so there is no shared mutation point — the pattern is
 * collision-free BY CONSTRUCTION (no registry needed). A story floor provider is
 * an ordinary `@Injectable` in the story module reading the story's entities,
 * mirroring {@link PostgresFloorProvider}'s shape.
 */

/** DI token for the {@link FloorProvider} (Unit 3 binds the Postgres-backed one). */
export const FLOOR_PROVIDER = 'FLOOR_PROVIDER';

/** Empty-floor provider for tests / pre-Unit-3. */
@Injectable()
export class EmptyFloorProvider implements FloorProvider {
  async cntFloor(): Promise<DurableFloor> {
    return { fields: {} };
  }
  async catFloor(): Promise<DurableFloor> {
    return { fields: {} };
  }
  async excFloor(): Promise<DurableFloor> {
    return { fields: {} };
  }
}

/**
 * Generic step-8 hot update: rehydrate-on-miss the open-day `cnt` bucket, then
 * (Unit 3) increment; mark the bucket dirty so the flusher upserts it. The `cat`
 * bucket is rehydrated + dirty-marked identically. This hook guarantees the
 * rehydrate + dirty-mark contract the flush engine relies on; the raw HINCRBY /
 * cat-field writes are the Unit-3 increment.
 */
@Injectable()
export class GenericHotUpdateHook implements HotUpdateHook {
  constructor(
    private readonly rehydrate: RehydrateService,
    private readonly dirty: DirtyRegistry,
    @Inject(FLOOR_PROVIDER) private readonly floors: FloorProvider,
    private readonly hot: HotBucketWriter,
    private readonly gameConfig: GameConfigService,
  ) {}

  async update(
    record: RoutedRecord,
    bucketName: string,
    _dedup: DedupPassedToken,
    _durable: DurableWrittenToken,
  ): Promise<HotUpdatedToken> {
    const gameId = record.envelope.game_id;
    const day = record.corrected_day;

    // R3: `bucketName` is the name resolved ONCE by step 3's name-cap gate — an
    // over-cap distinct name arrives here as the literal `other` bucket (kept +
    // counted), never dropped. The cnt HINCRBY field and the cat bucket key both
    // use it, keeping the other-overflow posture correct into the hot buckets.

    // ---- cnt bucket (class M): rehydrate from durable floor, THEN increment,
    // THEN mark dirty. Order matters: rehydrate (HSETNX seed) must precede the
    // HINCRBY so the increment lands on top of the durable floor, never on 0.
    const cntKey = IngestKeys.cnt(gameId, day);
    await this.rehydrate.seedIfMissing(cntKey, await this.floors.cntFloor(gameId, day));
    await this.hot.incrementCount(gameId, day, bucketName);
    await this.dirty.mark('cnt', cntKey);

    // ---- cat bucket (mixed, day-less): rehydrate, THEN the atomic mixed merge
    // (count++/first_seen-min/last_seen-max/pts-union), THEN mark dirty.
    const catKey = IngestKeys.cat(gameId, bucketName);
    await this.rehydrate.seedIfMissing(catKey, await this.floors.catFloor(gameId, bucketName));
    const propertyKeyCap =
      (await this.gameConfig.getNumber(gameId, 'property_key_cap_per_event')) ??
      GAME_CONFIG_DEFAULTS.property_key_cap_per_event;
    await this.hot.upsertCatalog({
      gameId,
      bucketName,
      kind: record.resolved_kind,
      // Catalog seen-times track the CORRECTED event time (same instant the day
      // bucket uses) so first/last-seen agree with the day counts.
      observedTimeMs: record.corrected_time,
      props: record.envelope.props,
      propertyKeyCap,
    });
    await this.dirty.mark('cat', catKey);

    // ---- rank zset (display-only, never flushed): increment last, off the flush
    // path entirely.
    await this.hot.incrementRank(gameId, day, bucketName);

    return {} as HotUpdatedToken;
  }
}

/**
 * Permissive default name-cap gate: no cap → returns the name unchanged. The
 * real per-game distinct-name budget + `other`-overflow (R3, §H-4) is a
 * Redis-set gate Unit 3 wires; this default keeps the kernel runnable and
 * NEVER drops (it can only return the name or `other`, never throw).
 */
@Injectable()
export class UncappedNameGate implements NameCapGate {
  async resolveName(_gameId: string, eventName: string): Promise<string> {
    return eventName;
  }
}

/**
 * Permissive default typed validator: accepts everything (returns null). Real
 * strict economy/purchase/session payload validation lives in those stories;
 * this default keeps the generic path testable without a validator.
 */
@Injectable()
export class PermissiveTypedValidator implements TypedValidator {
  validate(_kind: EventKind, _envelope: EventEnvelope): 'quarantined_typed' | null {
    return null;
  }
}

/**
 * No-op PII scrub port for tests / pre-security-module wiring: passes props
 * through unchanged. The real default-deny scrubber is the security module's
 * {@link KernelPiiScrubAdapter}, bound in WorkersModule — production always uses
 * the real one; this keeps the kernel unit-testable in isolation.
 */
@Injectable()
export class NoopPiiScrubPort implements PiiScrubPort {
  async scrubProps(_gameId: string, props: Record<string, unknown>): Promise<Record<string, unknown>> {
    return props;
  }
}
