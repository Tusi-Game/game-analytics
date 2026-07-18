/**
 * The flusher (foundation §3.2) — the repeatable Redis→Postgres job that sweeps
 * the per-domain dirty-registry and upserts ABSOLUTE values under the per-class
 * merge rule (§3.2.1). Shared by every story; 002 wires only its own `cnt`,
 * `cnt:exc` (class M) and `cat` (mixed) structures.
 *
 * INVARIANTS (all load-bearing):
 *   - SKIP any dirty bucket whose `seeded` marker is absent (DARK-SPOT #5 /
 *     ST2) — a half-seeded bucket must never be read into a flush. It is left in
 *     the registry (re-marked) and retried next sweep.
 *   - Deltas NEVER flush — the service only ever reads the CURRENT ABSOLUTE cell
 *     value (HGETALL) and upserts it; there is no additive path.
 *   - Every flush is a NO-OP on retry BY CONSTRUCTION — the merge SQL from
 *     flush-merge.ts is idempotent per class, so a duplicated sweep converges.
 *
 * The service exposes both the periodic `flushDomain()` (drains the registry)
 * and the `sealFinalFlush()` hook (the final flush that runs when a day seals,
 * after which the read model stops consulting Redis for that day — §3.2/§3.3).
 *
 * NOTE: the BullMQ repeatable-job REGISTRATION (scheduling this on
 * `flush_interval`) and the per-event step-8 INCREMENT that marks buckets dirty
 * are Unit 3's wiring. This service is the flush BODY those call.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { RehydrateService, SEEDED_MARKER_FIELD } from '../../common/redis-keys/rehydrate';
import { Domain } from '../../common/redis-keys/redis-keys';
import { DirtyRegistry } from './dirty-registry';
import { buildFlushStatement, FlushRow, MergeTableSpec } from './flush-merge';

export type { FlushRow, MergeTableSpec };

/**
 * ============ Class-N atomic-snapshot flush (Foundation §3.2.1) — 006 build gap ====
 * Class N (MONETIZATION_CELL / PAYER_DAY.revenue_day_total / rev day totals) is
 * gen-gated and MUTATES DOWNWARD (the enrichment MOVE decrements one cell and
 * increments another under one INCR gen). A plain HGETALL per hash could read the
 * decrement WITHOUT the paired increment (or vice-versa) if a MOVE interleaves — that
 * would flush a torn state. The class-N read MUST therefore snapshot ALL related cells
 * AND the gen TOGETHER, atomically. This Lua EVAL does exactly that: it reads the meta
 * `gen` field then every data hash in the plan, in one server-side atomic block, so a
 * MOVE is either fully before or fully after the snapshot (both-in / both-out).
 *
 * KEYS[1]      = meta hash (holds the `gen` field)
 * KEYS[2..n]   = the data hashes to snapshot (cnt/rev/loc/cat …)
 * ARGV[1]      = the gen field name inside the meta hash
 * ARGV[2]      = the seeded-marker field name (to check each data hash is seeded)
 * Returns a flat array: [ gen, seededFlags..., then per-data-hash: len, k1, v1, k2, v2, … ].
 * A data hash lacking the seeded marker reports seeded=0 so the caller SKIPS the flush.
 */
const CLASS_N_SNAPSHOT_LUA = `
local genField = ARGV[1]
local seededField = ARGV[2]
local gen = redis.call('HGET', KEYS[1], genField)
if gen == false then gen = '0' end
local out = { gen }
-- seeded flags, one per data hash (KEYS[2..])
for i = 2, #KEYS do
  local marker = redis.call('HGET', KEYS[i], seededField)
  if marker ~= false then
    out[#out + 1] = '1'
  else
    out[#out + 1] = '0'
  end
end
-- then each data hash's full contents, length-prefixed
for i = 2, #KEYS do
  local h = redis.call('HGETALL', KEYS[i])
  out[#out + 1] = tostring(#h)
  for j = 1, #h do
    out[#out + 1] = h[j]
  end
end
return out
`;

/**
 * One class-N flush plan: the meta (gen) key + the data hashes to snapshot atomically,
 * and a projector that receives the whole snapshot (all data hashes keyed by their role
 * + the read gen) and yields the gen-guarded {@link FlushRow}s.
 */
export interface ClassNFlushPlan {
  /** The dirty-registry domain to drain (e.g. `mon`, `rev`, `payer`). */
  readonly domain: Domain;
  /** The merge spec (must declare a `gen` guardColumn; the merge is gen-gated). */
  readonly spec: MergeTableSpec;
  /**
   * Given a drained data-hash bucket key, return the meta (gen) key and every data hash
   * key to snapshot atomically WITH it (typically the sibling cnt/rev/loc/cat hashes for
   * the same day). Return null to skip a bucket that is not this plan's shape.
   */
  readonly relatedKeys: (bucketKey: string) => { metaKey: string; dataKeys: readonly string[] } | null;
  /**
   * Project the atomic snapshot into gen-guarded rows. `dataHashes` maps each data-hash
   * key to its absolute contents (seeded, marker stripped); `gen` is the snapshot gen
   * every row is guarded by.
   */
  readonly projectN: (dataHashes: Record<string, Record<string, string>>, gen: number) => FlushRow[];
}

/**
 * Translates one Redis bucket key + its (already seeded-verified) hash contents
 * into the set of absolute {@link FlushRow}s to upsert into `spec.table`. Each
 * domain owner supplies this; 002 supplies the `cnt`/`cnt:exc`/`cat` projectors.
 * It receives ONLY absolute values (the current hash state), never deltas.
 */
export type BucketProjector = (bucketKey: string, hash: Record<string, string>) => FlushRow[];

/** One domain's flush plan: its dirty-registry domain, merge spec, projector. */
export interface DomainFlushPlan {
  domain: Domain;
  spec: MergeTableSpec;
  project: BucketProjector;
}

/** Outcome of a domain sweep (observability + test assertions). */
export interface FlushSweepResult {
  /** Buckets drained from the registry this sweep. */
  drained: number;
  /** Buckets flushed (seeded, non-empty). */
  flushed: number;
  /** Buckets SKIPPED because their `seeded` marker was absent (re-queued). */
  skippedUnseeded: number;
  /** Absolute upserts executed. */
  upserts: number;
}

@Injectable()
export class FlushService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly rehydrate: RehydrateService,
    private readonly dirty: DirtyRegistry,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Sweep one domain: drain its dirty-registry, and for each bucket that IS
   * seeded, read its absolute hash and upsert every projected row idempotently.
   * A bucket whose `seeded` marker is absent is SKIPPED and re-marked (ST2).
   */
  async flushDomain(plan: DomainFlushPlan): Promise<FlushSweepResult> {
    const buckets = await this.dirty.drain(plan.domain);
    const result: FlushSweepResult = { drained: buckets.length, flushed: 0, skippedUnseeded: 0, upserts: 0 };

    for (const bucketKey of buckets) {
      // Primary half-seed guard (DARK-SPOT #5): never flush an unseeded bucket.
      if (!(await this.rehydrate.isSeeded(bucketKey))) {
        result.skippedUnseeded += 1;
        // Re-queue so the next sweep retries it once seeding completes.
        await this.dirty.mark(plan.domain, bucketKey);
        continue;
      }

      const upserts = await this.flushBucket(plan, bucketKey);
      result.upserts += upserts;
      result.flushed += 1;
    }

    return result;
  }

  /**
   * Seal-time final flush (§3.2/§3.3): flush the given bucket keys one last time
   * as a day seals, after which the read model reads that day from Postgres
   * only. Same idempotent path — it may safely re-run buckets already flushed
   * this cadence (no-op by construction). Unlike the periodic sweep it flushes
   * the explicit bucket list (the day's cells) rather than draining the
   * registry, and it still honours the seeded-skip guard.
   */
  async sealFinalFlush(plan: DomainFlushPlan, bucketKeys: string[]): Promise<FlushSweepResult> {
    const result: FlushSweepResult = { drained: bucketKeys.length, flushed: 0, skippedUnseeded: 0, upserts: 0 };
    for (const bucketKey of bucketKeys) {
      if (!(await this.rehydrate.isSeeded(bucketKey))) {
        result.skippedUnseeded += 1;
        // A day cannot finalize on an unseeded bucket — leave it dirty so the
        // seal defers (ops-envelope §4: seal defers rather than finalizing short).
        await this.dirty.mark(plan.domain, bucketKey);
        continue;
      }
      result.upserts += await this.flushBucket(plan, bucketKey);
      result.flushed += 1;
    }
    return result;
  }

  /**
   * Read one seeded bucket's ABSOLUTE hash and upsert its projected rows. The
   * reserved `seeded` marker field is stripped before projection so it never
   * leaks into a cell value.
   */
  private async flushBucket(plan: DomainFlushPlan, bucketKey: string): Promise<number> {
    const hash = await this.redis.hgetall(bucketKey);
    // Strip the reserved marker — it is bookkeeping, not a cell.
    delete hash[SEEDED_MARKER_FIELD];

    const rows = plan.project(bucketKey, hash);
    let upserts = 0;
    for (const row of rows) {
      const { sql, params } = buildFlushStatement(plan.spec, row);
      await this.dataSource.query(sql, params);
      upserts += 1;
    }
    return upserts;
  }

  // -------------------------------------------------------------------------
  // Class-N atomic-snapshot flush (006 build gap). ADDITIVE — does not touch the
  // M/S/L/cat path above. The drained data-hash bucket triggers ONE Lua snapshot
  // of (gen + all related data hashes), then the projector yields gen-guarded rows.
  // -------------------------------------------------------------------------

  /**
   * Sweep one class-N domain: drain its dirty-registry, and for each drained DATA-HASH
   * bucket, atomically snapshot (gen + all related data hashes) and upsert the projected
   * gen-guarded rows. A related data hash lacking the seeded marker → SKIP + re-mark
   * (half-seed guard, ST2). The gen guard (WHERE EXCLUDED.gen >= target.gen) rejects a
   * stale snapshot at the merge, so a duplicated sweep or a mid-MOVE torn read converges.
   *
   * `dedupe` collapses buckets that share the same related-key set (the mon cnt/rev/loc
   * data hashes for one day all resolve to the SAME snapshot) so the snapshot runs once
   * per (game, day), not once per drained sibling.
   */
  async flushClassNDomain(plan: ClassNFlushPlan): Promise<FlushSweepResult> {
    const buckets = await this.dirty.drain(plan.domain);
    return this.flushClassNBuckets(plan, buckets);
  }

  /**
   * Seal-time / explicit class-N flush for a specific bucket list (mirrors
   * {@link sealFinalFlush} for the M/S/L path). Same atomic-snapshot body; used by the
   * flush job's sweep + the seal finalize + the FX-recompute re-flush.
   */
  async sealFinalFlushClassN(plan: ClassNFlushPlan, bucketKeys: string[]): Promise<FlushSweepResult> {
    return this.flushClassNBuckets(plan, bucketKeys);
  }

  private async flushClassNBuckets(plan: ClassNFlushPlan, buckets: string[]): Promise<FlushSweepResult> {
    const result: FlushSweepResult = { drained: buckets.length, flushed: 0, skippedUnseeded: 0, upserts: 0 };
    // Collapse to distinct snapshots (same related-key set → one snapshot). Key the
    // dedupe by the meta key + sorted data keys.
    const seen = new Set<string>();
    for (const bucketKey of buckets) {
      const related = plan.relatedKeys(bucketKey);
      if (!related) {
        continue; // not this plan's shape
      }
      const snapId = [related.metaKey, ...[...related.dataKeys].sort()].join('');
      if (seen.has(snapId)) {
        continue;
      }
      seen.add(snapId);

      const snapshot = await this.snapshotClassN(related.metaKey, related.dataKeys);
      if (!snapshot.allSeeded) {
        // A data hash was half-seeded → defer: re-mark the drained bucket, skip.
        result.skippedUnseeded += 1;
        await this.dirty.mark(plan.domain, bucketKey);
        continue;
      }

      const rows = plan.projectN(snapshot.dataHashes, snapshot.gen);
      for (const row of rows) {
        const { sql, params } = buildFlushStatement(plan.spec, row);
        await this.dataSource.query(sql, params);
        result.upserts += 1;
      }
      result.flushed += 1;
    }
    return result;
  }

  /**
   * Run the atomic class-N snapshot: gen + every data hash, in ONE Lua EVAL. Strips the
   * seeded marker from each data hash and reports `allSeeded=false` if ANY related data
   * hash lacked the marker (defer the flush). Returns the read gen + each data hash's
   * absolute contents keyed by its Redis key.
   */
  private async snapshotClassN(
    metaKey: string,
    dataKeys: readonly string[],
  ): Promise<{ gen: number; dataHashes: Record<string, Record<string, string>>; allSeeded: boolean }> {
    const raw = (await this.redis.eval(
      CLASS_N_SNAPSHOT_LUA,
      dataKeys.length + 1,
      metaKey,
      ...dataKeys,
      'gen',
      SEEDED_MARKER_FIELD,
    )) as string[];

    let cursor = 0;
    const gen = Number(raw[cursor] ?? '0');
    cursor += 1;

    // seeded flags, one per data hash
    const seededFlags: boolean[] = [];
    for (let i = 0; i < dataKeys.length; i += 1) {
      seededFlags.push(raw[cursor] === '1');
      cursor += 1;
    }
    const allSeeded = seededFlags.every((s) => s);

    const dataHashes: Record<string, Record<string, string>> = {};
    for (let i = 0; i < dataKeys.length; i += 1) {
      const key = dataKeys[i]!;
      const len = Number(raw[cursor] ?? '0');
      cursor += 1;
      const hash: Record<string, string> = {};
      for (let j = 0; j < len; j += 2) {
        const field = raw[cursor];
        const value = raw[cursor + 1];
        cursor += 2;
        if (field === undefined || field === SEEDED_MARKER_FIELD) {
          continue;
        }
        hash[field] = value ?? '';
      }
      dataHashes[key] = hash;
    }

    return { gen: Number.isFinite(gen) ? gen : 0, dataHashes, allSeeded };
  }
}
