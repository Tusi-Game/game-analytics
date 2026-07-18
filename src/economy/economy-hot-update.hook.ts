/**
 * Step-8 hot-update hook for `kind = economy` (T-03.20, design Worker step 8).
 * Registered with the kind dispatcher under KIND_HOT_REGISTRATION.
 *
 * COMPOSITION CONTRACT (kind-dispatch.ts): the dispatcher runs the GENERIC
 * cat/cnt/rank base FIRST, then THIS hook. So this hook implements ONLY the
 * economy accumulators (eco / eco:seg / bal) — it MUST NOT redo cat/cnt/rank.
 *
 * Economy owns NO step-7 durable write (bound to Noop). Everything here is
 * transient-and-losable (Foundation §6): a Redis loss forfeits ≤ the current
 * flush window + today's live increments; the durable results + the raw floor
 * survive, so no economy event is ever counted-but-unlogged.
 *
 * Order (design step 8):
 *   1. Resolve the currency through the cap gate (SADD into `{game}:eco:cur` +
 *      R3 other-overflow: over-cap → `other`, KEPT + counted, never dropped).
 *   2. Base cell in `{game}:eco:{corrected_day}` — rehydrate-on-miss FIRST, then
 *      HINCRBY amount_sum (`a␟…`) AND event_count (`n␟…`), then mark dirty.
 *   3. For each PRESENT segment dim (level_bucket, region) → increment the matching
 *      `:seg` cell (observed segments only materialize). Independent axes.
 *   4. If depth on AND a valid `balance_after` → guarded LWW upsert into
 *      `{game}:bal:{currency}` + add the entry to `bal:dirty`.
 *
 * Consumes `record.corrected_day` VERBATIM (P8 — never re-derives the day) and
 * `record.provenance` VERBATIM (§4.5 credential-class derivation). Reads the
 * strict payload with the same field readers the step-3 validator used.
 */

import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { Inject } from '@nestjs/common';
import { REDIS_CLIENT } from '../redis/redis.constants';
import type { RoutedRecord } from '../common/contracts/queue-jobs';
import type {
  DedupPassedToken,
  DurableWrittenToken,
  HotUpdatedToken,
  HotUpdateHook,
} from '../workers/kernel/pipeline-steps';
import { RehydrateService } from '../common/redis-keys/rehydrate';
import { DirtyRegistry } from '../workers/flush/dirty-registry';
import { EcoCurrencyCapGate } from './eco-currency-cap.gate';
import { EconomyFloorProvider } from './economy-floor.provider';
import { BalanceLwwService } from './balance-lww.service';
import { EconomyConfigService, computeLevelBucket } from './economy-config.service';
import { readAmount, readBalanceAfter, readCurrencyType, readFlowType, readReason } from './economy-typed.validator';
import {
  EcoKeys,
  ecoField,
  ecoSegField,
  MEASURE_AMOUNT,
  MEASURE_COUNT,
  type BalanceEntry,
  type Provenance,
  type SegmentDim,
} from './eco-keys';

@Injectable()
export class EconomyHotUpdateHook implements HotUpdateHook {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly rehydrate: RehydrateService,
    private readonly dirty: DirtyRegistry,
    private readonly currencyCap: EcoCurrencyCapGate,
    private readonly floors: EconomyFloorProvider,
    private readonly balanceLww: BalanceLwwService,
    private readonly economyConfig: EconomyConfigService,
  ) {}

  async update(
    record: RoutedRecord,
    _bucketName: string,
    _dedup: DedupPassedToken,
    _durable: DurableWrittenToken,
  ): Promise<HotUpdatedToken> {
    const { envelope } = record;
    const gameId = envelope.game_id;
    const props = envelope.props;

    // The step-3 validator guaranteed shape; read the strict fields (defensive
    // guards keep this total if a stray non-economy record ever reaches here).
    const flowType = readFlowType(props);
    const rawCurrency = readCurrencyType(props);
    const amount = readAmount(props);
    const reason = readReason(props);
    if (flowType === null || rawCurrency === null || amount === null || reason === null) {
      return {} as HotUpdatedToken;
    }

    // Forward-only allowlist gate (T-03.14): when a non-empty allowlist excludes
    // this currency, DO NOT accumulate (the event was already raw-appended in
    // step 4, so it stays recoverable — quarantine-from-counting). No cap SADD.
    const allowlist = await this.economyConfig.currencyAllowlist(gameId);
    if (allowlist && !allowlist.has(rawCurrency)) {
      return {} as HotUpdatedToken;
    }

    const provenance = record.provenance as Provenance;
    const day = record.corrected_day; // P8: consume verbatim, never re-derive.
    const amountInt = Math.trunc(amount); // BIGINT cells hold integer magnitudes.

    // ---- 1. Currency cap gate: SADD into eco:cur + R3 other-overflow ----------
    const currency = await this.currencyCap.resolveCurrency(gameId, rawCurrency);

    // ---- 2. Base cell: rehydrate-on-miss FIRST, then amount + count, then dirty
    const ecoKey = EcoKeys.eco(gameId, day);
    await this.rehydrate.seedIfMissing(ecoKey, await this.floors.ecoFloor(gameId, day));
    await this.redis.hincrby(ecoKey, ecoField(MEASURE_AMOUNT, provenance, flowType, currency, reason), amountInt);
    await this.redis.hincrby(ecoKey, ecoField(MEASURE_COUNT, provenance, flowType, currency, reason), 1);
    await this.dirty.mark('eco', ecoKey);

    // ---- 3. Segment axes (independent; observed segments only materialize) ----
    const segments = await this.segmentAxes(gameId, props);
    if (segments.length > 0) {
      const segKey = EcoKeys.ecoSeg(gameId, day);
      await this.rehydrate.seedIfMissing(segKey, await this.floors.ecoSegFloor(gameId, day));
      for (const { dim, value } of segments) {
        await this.redis.hincrby(
          segKey,
          ecoSegField(MEASURE_AMOUNT, provenance, flowType, currency, dim, value, reason),
          amountInt,
        );
        await this.redis.hincrby(
          segKey,
          ecoSegField(MEASURE_COUNT, provenance, flowType, currency, dim, value, reason),
          1,
        );
      }
      await this.dirty.mark('eco', segKey);
    }

    // ---- 4. Depth: guarded LWW bal upsert (only when depth on + valid balance) -
    const balanceAfter = readBalanceAfter(props);
    if (balanceAfter !== null && typeof envelope.user_id === 'string' && envelope.user_id.length > 0) {
      if (await this.economyConfig.depthCaptureOn(gameId)) {
        const entry: BalanceEntry = {
          balance: String(Math.trunc(balanceAfter)),
          asOfMs: record.corrected_time,
          provenance,
          serverReceivedMs: envelope.server_received_time,
          eventId: envelope.event_id,
        };
        await this.balanceLww.upsert(gameId, envelope.user_id, currency, entry);
      }
    }

    return {} as HotUpdatedToken;
  }

  /**
   * The PRESENT independent segment axes for this event. `level_bucket` is
   * computed from raw `player_level` (raw level never stored); `region` rides
   * verbatim if present. An absent dim contributes to NO segment cell (never a
   * cross-product). Returns [] when neither is present.
   */
  private async segmentAxes(
    gameId: string,
    props: Record<string, unknown>,
  ): Promise<Array<{ dim: SegmentDim; value: string }>> {
    const axes: Array<{ dim: SegmentDim; value: string }> = [];

    const boundaries = await this.economyConfig.levelBucketBoundaries(gameId);
    const levelBucket = computeLevelBucket(props['player_level'], boundaries);
    if (levelBucket !== null) {
      axes.push({ dim: 'level_bucket', value: levelBucket });
    }

    const region = props['region'];
    if (typeof region === 'string' && region.length > 0) {
      axes.push({ dim: 'region', value: region });
    }

    return axes;
  }
}
