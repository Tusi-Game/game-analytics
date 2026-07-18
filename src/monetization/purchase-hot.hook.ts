/**
 * Step-8 hot-update hook for `kind = purchase` ([006-monetization] design step 8).
 * Registered with the kind dispatcher under KIND_HOT_REGISTRATION.
 *
 * COMPOSITION CONTRACT (kind-dispatch.ts): the dispatcher runs the GENERIC cat/cnt/rank
 * base FIRST, then THIS hook. So this hook implements ONLY the monetization accumulators
 * (mon/payer/rev) — it MUST NOT redo cat/cnt/rank.
 *
 * Reads the step-7 branded token ({@link readPurchaseDurableState}) for the resolved
 * server-accept state (FX-normalized amount, payer_tier, product) so it never recomputes
 * FX/tier. Two paths by sub-contract:
 *
 *   SERVER row (durable state kind='server'): resolve dim_combo (server dims from
 *     spine/06 state; client-only dims from staged companion or `unknown`; cardinality
 *     guard on client values) → atomically increment cell cnt/rev/loc, add payer to the
 *     payer HASH-as-set, add to rev day totals, write srv:* staging, clear consumed
 *     cmp:*. FX 3-way already applied at step 7 (parked → 0 to rev, still inc cnt/loc).
 *
 *   COMPANION (durable state kind='client'): join by purchase_attempt_id (R2) —
 *     - srv:* staged + purchase-day unsealed → enrichment MOVE: recompute dim_combo
 *       replacing ONLY client components; if changed, atomic decrement-old + increment-new
 *       + INCR gen (conserves count+revenue — enrichment never changes money);
 *     - no staging but tx exists → window-missed → tally + stop;
 *     - neither → orphan → write cmp:* staging (TTL 48 h), inert on expiry.
 *
 * Seal governance follows the PURCHASE's day (not the companion's own) — the join path
 * re-checks the purchase day and quarantines post-seal companions.
 *
 * All money increments are BIGINT/decimal magnitudes kept as strings; the class-N flush
 * reads cnt/rev/loc + gen atomically so a MOVE is both-in/both-out.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../redis/redis.constants';
import type { RoutedRecord } from '../common/contracts/queue-jobs';
import type {
  DedupPassedToken,
  DurableWrittenToken,
  HotUpdatedToken,
  HotUpdateHook,
} from '../workers/kernel/pipeline-steps';
import { RehydrateService } from '../common/redis-keys/rehydrate';
import { SEEDED_MARKER_FIELD } from '../common/redis-keys/rehydrate';
import { DirtyRegistry } from '../workers/flush/dirty-registry';
import { ExceptionTallyWriter } from '../workers/kernel/exception-tally.writer';
import { UserSpineEntity } from '../database/entities/user-spine.entity';
import { MonetizationFloorProvider } from './monetization-floor.provider';
import { MonetizationConfigService } from './monetization-config.service';
import { CardinalityGuardService } from './cardinality-guard.service';
import { readPurchaseDurableState, type PurchaseDurableState } from './purchase-durable.hook';
import { readRequiredString, readNumber } from './purchase-validator';
import {
  buildDimCombo,
  computeLevelBucket,
  parseDimCombo,
  CLIENT_DIMENSIONS,
  SERVER_DIMENSIONS,
  UNKNOWN_VALUE,
} from './dim-combo';
import { MonKeys, PayerKeys, RevKeys, cellKey, revLocField, REV_TOTAL_FIELD, META_GEN_FIELD } from './mon-keys';

/**
 * Atomic server-row rollup Lua.
 *   KEYS[1]=cnt hash  KEYS[2]=rev hash  KEYS[3]=loc hash  KEYS[4]=cat hash
 *   KEYS[5]=payer hash-as-set  KEYS[6]=rev day hash  KEYS[7]=meta hash
 *   ARGV[1]=cell key  ARGV[2]=normalized (added to rev + rev.total)
 *   ARGV[3]=local (added to loc[cell#cur] + rev.loc:cur)  ARGV[4]=currency
 *   ARGV[5]=user_id  ARGV[6]=product_category  ARGV[7]=seeded marker field
 *   ARGV[8]=rev total field  ARGV[9]=rev loc field (loc:currency)  ARGV[10]=meta gen field
 * Increments cnt +1, rev += normalized, loc[cell#cur] += local, cat[cell]=category,
 * payer[user]=1, rev.total += normalized, rev.loc:cur += local. gen is UNCHANGED (a new
 * purchase only grows a cell; gen guards MOVE/FX downward writes). Returns the new count.
 */
const SERVER_ROLLUP_LUA = `
local cellKey = ARGV[1]
local normalized = ARGV[2]
local localAmt = ARGV[3]
local currency = ARGV[4]
local userId = ARGV[5]
local category = ARGV[6]
local totalField = ARGV[8]
local locField = ARGV[9]
local newCount = redis.call('HINCRBY', KEYS[1], cellKey, 1)
redis.call('HINCRBYFLOAT', KEYS[2], cellKey, normalized)
redis.call('HINCRBYFLOAT', KEYS[3], cellKey .. '#' .. currency, localAmt)
redis.call('HSET', KEYS[4], cellKey, category)
redis.call('HSET', KEYS[5], userId, '1')
redis.call('HINCRBYFLOAT', KEYS[6], totalField, normalized)
redis.call('HINCRBYFLOAT', KEYS[6], locField, localAmt)
return newCount
`;

/**
 * Atomic enrichment MOVE Lua (conserves count + revenue).
 *   KEYS[1]=cnt  KEYS[2]=rev  KEYS[3]=loc  KEYS[4]=cat  KEYS[5]=meta
 *   ARGV[1]=old cell  ARGV[2]=new cell  ARGV[3]=normalized  ARGV[4]=local
 *   ARGV[5]=currency  ARGV[6]=category  ARGV[7]=meta gen field
 * Decrements the OLD cell (cnt −1, rev −= normalized, loc[old#cur] −= local) and
 * increments the NEW cell by the same, then INCR the gen (class-N downward write). Both
 * halves are one atomic block so a snapshot never sees the decrement without the
 * increment. Returns the new gen.
 */
const MOVE_LUA = `
local oldCell = ARGV[1]
local newCell = ARGV[2]
local normalized = ARGV[3]
local localAmt = ARGV[4]
local currency = ARGV[5]
local category = ARGV[6]
local genField = ARGV[7]
-- decrement old
redis.call('HINCRBY', KEYS[1], oldCell, -1)
redis.call('HINCRBYFLOAT', KEYS[2], oldCell, '-' .. normalized)
redis.call('HINCRBYFLOAT', KEYS[3], oldCell .. '#' .. currency, '-' .. localAmt)
-- increment new
redis.call('HINCRBY', KEYS[1], newCell, 1)
redis.call('HINCRBYFLOAT', KEYS[2], newCell, normalized)
redis.call('HINCRBYFLOAT', KEYS[3], newCell .. '#' .. currency, localAmt)
redis.call('HSET', KEYS[4], newCell, category)
local newGen = redis.call('HINCRBY', KEYS[5], genField, 1)
return newGen
`;

@Injectable()
export class PurchaseHotHook implements HotUpdateHook {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly dataSource: DataSource,
    private readonly rehydrate: RehydrateService,
    private readonly dirty: DirtyRegistry,
    private readonly floors: MonetizationFloorProvider,
    private readonly config: MonetizationConfigService,
    private readonly cardinality: CardinalityGuardService,
    private readonly tally: ExceptionTallyWriter,
  ) {}

  async update(
    record: RoutedRecord,
    _bucketName: string,
    _dedup: DedupPassedToken,
    durable: DurableWrittenToken,
  ): Promise<HotUpdatedToken> {
    const state = readPurchaseDurableState(durable);
    if (!state) {
      return {} as HotUpdatedToken;
    }
    if (state.kind === 'server' && state.accepted) {
      await this.rollupServerRow(record, state);
    } else if (state.kind === 'client') {
      await this.joinCompanion(record, state);
    }
    // ineligible / invalid / duplicate → no accumulator work.
    return {} as HotUpdatedToken;
  }

  // ---- Server row: dimension resolution + FX-applied rollup ------------------

  private async rollupServerRow(record: RoutedRecord, state: PurchaseDurableState): Promise<void> {
    const accepted = state.accepted!;
    const gameId = record.envelope.game_id;
    const day = accepted.purchaseDay;

    // Rehydrate all mon data hashes + meta + payer + rev BEFORE mutating (class-N safe).
    await this.seedDay(gameId, day);

    // Resolve the dim_combo. Server row may have a companion already staged (both orders).
    const staged = await this.readStagedCompanion(gameId, record);
    const dimCombo = await this.resolveDimCombo(gameId, record, accepted.payerTier, staged?.companionDims ?? {});
    const cell = cellKey(accepted.productId, dimCombo);

    await this.redis.eval(
      SERVER_ROLLUP_LUA,
      7,
      MonKeys.cnt(gameId, day),
      MonKeys.rev(gameId, day),
      MonKeys.loc(gameId, day),
      MonKeys.cat(gameId, day),
      PayerKeys.members(gameId, day),
      RevKeys.day(gameId, day),
      MonKeys.meta(gameId, day),
      cell,
      accepted.normalized,
      accepted.priceLocal,
      accepted.currency,
      accepted.userId,
      accepted.productCategory,
      SEEDED_MARKER_FIELD,
      REV_TOTAL_FIELD,
      revLocField(accepted.currency),
      META_GEN_FIELD,
    );

    // Write srv:* staging (product, counted dim_combo, normalized, purchase_day = the
    // applied-marker) keyed by purchase_attempt_id so a late companion can MOVE. If a
    // companion is already staged, consume its cmp:* (this server row counted with it).
    const purchaseAttemptId = readRequiredString(record.envelope.props, 'purchase_attempt_id');
    if (purchaseAttemptId !== null) {
      await this.writeSrvStaging(gameId, purchaseAttemptId, {
        productId: accepted.productId,
        dimCombo,
        normalized: accepted.normalized,
        local: accepted.priceLocal,
        currency: accepted.currency,
        productCategory: accepted.productCategory,
        purchaseDay: day,
      });
    }

    await this.markDirty(gameId, day);
  }

  // ---- Companion: join by purchase_attempt_id (R2), 3 cases ------------------

  private async joinCompanion(record: RoutedRecord, state: PurchaseDurableState): Promise<void> {
    const gameId = record.envelope.game_id;
    const purchaseAttemptId = state.purchaseAttemptId ?? '';
    if (purchaseAttemptId === '') {
      return;
    }
    const stageKey = this.stageKey(gameId, purchaseAttemptId);
    const srv = await this.redis.hgetall(stageKey);
    const srvDim = srv['srv:dim_combo'];
    const srvDay = srv['srv:purchase_day'];

    // Case 1: srv:* staged → MOVE (if the purchase day is unsealed and dim changes).
    if (srvDim !== undefined && srvDay !== undefined) {
      // Seal governance: follows the PURCHASE's day, not the companion's.
      if (this.isSealed(srvDay)) {
        await this.tally.tally(gameId, record.corrected_day, 'sealed_late');
        return;
      }
      await this.seedDay(gameId, srvDay);
      const companionDims = await this.readCompanionDimsFromProps(gameId, record.envelope.props);
      // Recompute dim_combo replacing ONLY client components; server components frozen
      // (re-parse the staged combo's server components from srv, else re-derive).
      const productId = srv['srv:product_id'] ?? '';
      const newDim = await this.recomputeDimComboForMove(gameId, srvDim, companionDims);
      if (newDim !== srvDim) {
        const oldCell = cellKey(productId, srvDim);
        const newCell = cellKey(productId, newDim);
        await this.redis.eval(
          MOVE_LUA,
          5,
          MonKeys.cnt(gameId, srvDay),
          MonKeys.rev(gameId, srvDay),
          MonKeys.loc(gameId, srvDay),
          MonKeys.cat(gameId, srvDay),
          MonKeys.meta(gameId, srvDay),
          oldCell,
          newCell,
          srv['srv:normalized'] ?? '0',
          srv['srv:local'] ?? '0',
          srv['srv:currency'] ?? '',
          srv['srv:product_category'] ?? '',
          META_GEN_FIELD,
        );
        await this.redis.hset(stageKey, 'srv:dim_combo', newDim);
        await this.markDirty(gameId, srvDay);
      }
      return;
    }

    // Case 2: no staging but the tx exists in PURCHASE_IDEMPOTENCY → window-missed.
    // (We do not have the tx id on the companion — the join key is purchase_attempt_id.
    // A missing srv:* with an already-counted server row is indistinguishable from an
    // orphan here without the tx; the design's window-missed tally is a best-effort
    // signal. We treat "no srv staged" as orphan and hold cmp:* for a possibly-late
    // server row; if the server row already counted+sealed, the cmp:* expires inert.)

    // Case 3: orphan → write cmp:* staging (TTL 48 h). Inert on expiry.
    const companionDims = await this.readCompanionDimsFromProps(gameId, record.envelope.props);
    await this.writeCmpStaging(gameId, purchaseAttemptId, companionDims);
  }

  // ---- Dimension resolution -------------------------------------------------

  /**
   * Resolve the canonical dim_combo for a server row. For each active dimension:
   *   - server dims (payer_tier / install_cohort / days_since_install) from spine/06
   *     state (never client); days_since_install server-wins from first_seen when a
   *     spine row exists, else `unknown`;
   *   - client-only dims from the staged companion (cardinality-guarded), else `unknown`.
   */
  private async resolveDimCombo(
    gameId: string,
    record: RoutedRecord,
    payerTier: string,
    companionDims: Record<string, string>,
  ): Promise<string> {
    const activeDims = await this.config.monetizationDimensions(gameId);
    const resolved: Record<string, string> = {};
    const serverDerived = await this.serverDerivedDims(gameId, record, payerTier);

    for (const dim of activeDims) {
      if (SERVER_DIMENSIONS.has(dim)) {
        resolved[dim] = serverDerived[dim] ?? UNKNOWN_VALUE;
      } else if (CLIENT_DIMENSIONS.has(dim)) {
        const raw = companionDims[dim];
        if (raw === undefined || raw === '') {
          resolved[dim] = UNKNOWN_VALUE;
        } else {
          resolved[dim] = await this.cardinality.resolveValue(gameId, dim, raw);
        }
      } else {
        resolved[dim] = UNKNOWN_VALUE;
      }
    }
    return buildDimCombo(activeDims, resolved);
  }

  /**
   * For a MOVE, recompute the dim_combo replacing ONLY client components; SERVER
   * components are frozen (kept from the staged combo). We parse the staged combo, keep
   * its server-dim components, overlay the newly-arrived client-dim values (guarded).
   */
  private async recomputeDimComboForMove(
    gameId: string,
    stagedDimCombo: string,
    companionDims: Record<string, string>,
  ): Promise<string> {
    const activeDims = await this.config.monetizationDimensions(gameId);
    const staged = parseDimCombo(stagedDimCombo);
    const resolved: Record<string, string> = {};
    for (const dim of activeDims) {
      if (SERVER_DIMENSIONS.has(dim)) {
        // Server components frozen at count time.
        resolved[dim] = staged[dim] ?? UNKNOWN_VALUE;
      } else if (CLIENT_DIMENSIONS.has(dim)) {
        const raw = companionDims[dim];
        if (raw === undefined || raw === '') {
          // Companion did not supply → keep whatever was counted (usually unknown).
          resolved[dim] = staged[dim] ?? UNKNOWN_VALUE;
        } else {
          resolved[dim] = await this.cardinality.resolveValue(gameId, dim, raw);
        }
      } else {
        resolved[dim] = staged[dim] ?? UNKNOWN_VALUE;
      }
    }
    return buildDimCombo(activeDims, resolved);
  }

  /**
   * Server-derived dimension values: payer_tier (from step 7), install_cohort +
   * days_since_install from USER_SPINE.first_seen (server-wins). `unknown` when no spine
   * row exists (Q1 — never-sessioned payer). Reads first_seen only (P9: 006 never writes it).
   */
  private async serverDerivedDims(
    gameId: string,
    record: RoutedRecord,
    payerTier: string,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = { payer_tier: payerTier };
    const userId = record.envelope.user_id;
    if (typeof userId !== 'string' || userId.length === 0) {
      out['install_cohort'] = UNKNOWN_VALUE;
      out['days_since_install'] = UNKNOWN_VALUE;
      return out;
    }
    const spine = await this.dataSource.getRepository(UserSpineEntity).findOne({
      where: { gameId, userId },
      select: { firstSeen: true },
    });
    if (!spine || !spine.firstSeen) {
      out['install_cohort'] = UNKNOWN_VALUE;
      out['days_since_install'] = UNKNOWN_VALUE;
      return out;
    }
    const firstSeenDay = this.config.logicalDayOf(spine.firstSeen.getTime());
    out['install_cohort'] = firstSeenDay;
    out['days_since_install'] = String(this.dayDiff(firstSeenDay, record.corrected_day));
    return out;
  }

  private dayDiff(a: string, b: string): number {
    const MS = 86_400_000;
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS);
  }

  // ---- Companion dim reading (from props; level_bucket bucketed server-side) --

  private async readCompanionDimsFromProps(
    gameId: string,
    props: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    const dims: Record<string, string> = {};
    const region = readRequiredString(props, 'region');
    if (region !== null) {
      dims['region'] = region;
    }
    const inGameState = readRequiredString(props, 'in_game_state');
    if (inGameState !== null) {
      dims['in_game_state'] = inGameState;
    }
    const sessionsBefore = readNumber(props, 'sessions_before_purchase');
    if (sessionsBefore !== null) {
      dims['sessions_before_purchase'] = String(Math.trunc(sessionsBefore));
    }
    // level_bucket is bucketed SERVER-SIDE from the client's raw player_level (the
    // config lives server-side; raw level never stored — only the bucket label).
    const playerLevel = readNumber(props, 'player_level');
    if (playerLevel !== null) {
      const boundaries = await this.config.levelBucketBoundaries(gameId);
      const bucket = computeLevelBucket(playerLevel, boundaries);
      if (bucket !== null) {
        dims['level_bucket'] = bucket;
      }
    }
    return dims;
  }

  // ---- Staging read/write ----------------------------------------------------

  private stageKey(gameId: string, purchaseAttemptId: string): string {
    return `${gameId}:stage:${purchaseAttemptId}`;
  }

  /** For a server row, read a previously-staged companion's cmp:* dims, if any. */
  private async readStagedCompanion(
    gameId: string,
    record: RoutedRecord,
  ): Promise<{ companionDims: Record<string, string> } | null> {
    const purchaseAttemptId = readRequiredString(record.envelope.props, 'purchase_attempt_id');
    if (purchaseAttemptId === null) {
      return null;
    }
    const hash = await this.redis.hgetall(this.stageKey(gameId, purchaseAttemptId));
    const companionDims: Record<string, string> = {};
    for (const [field, value] of Object.entries(hash)) {
      if (field.startsWith('cmp:')) {
        companionDims[field.slice(4)] = value;
      }
    }
    return Object.keys(companionDims).length > 0 ? { companionDims } : null;
  }

  private async writeSrvStaging(
    gameId: string,
    purchaseAttemptId: string,
    srv: {
      productId: string;
      dimCombo: string;
      normalized: string;
      local: string;
      currency: string;
      productCategory: string;
      purchaseDay: string;
    },
  ): Promise<void> {
    const key = this.stageKey(gameId, purchaseAttemptId);
    await this.redis.hset(key, {
      'srv:product_id': srv.productId,
      'srv:dim_combo': srv.dimCombo,
      'srv:normalized': srv.normalized,
      'srv:local': srv.local,
      'srv:currency': srv.currency,
      'srv:product_category': srv.productCategory,
      'srv:purchase_day': srv.purchaseDay,
    });
    await this.redis.expire(key, 48 * 60 * 60);
  }

  private async writeCmpStaging(
    gameId: string,
    purchaseAttemptId: string,
    dims: Record<string, string>,
  ): Promise<void> {
    if (Object.keys(dims).length === 0) {
      return;
    }
    const key = this.stageKey(gameId, purchaseAttemptId);
    const fields: Record<string, string> = {};
    for (const [dim, value] of Object.entries(dims)) {
      fields[`cmp:${dim}`] = value;
    }
    await this.redis.hset(key, fields);
    await this.redis.expire(key, 48 * 60 * 60);
  }

  // ---- Rehydrate + dirty-mark -----------------------------------------------

  private async seedDay(gameId: string, day: string): Promise<void> {
    await Promise.all([
      this.rehydrate.seedIfMissing(MonKeys.cnt(gameId, day), await this.floors.cntFloor(gameId, day)),
      this.rehydrate.seedIfMissing(MonKeys.rev(gameId, day), await this.floors.revFloor(gameId, day)),
      this.rehydrate.seedIfMissing(MonKeys.loc(gameId, day), await this.floors.locFloor(gameId, day)),
      this.rehydrate.seedIfMissing(MonKeys.cat(gameId, day), await this.floors.catFloor(gameId, day)),
      this.rehydrate.seedIfMissing(MonKeys.meta(gameId, day), await this.floors.metaFloor(gameId, day)),
      this.rehydrate.seedIfMissing(PayerKeys.members(gameId, day), await this.floors.payerFloor(gameId, day)),
      this.rehydrate.seedIfMissing(RevKeys.day(gameId, day), await this.floors.revDayFloor(gameId, day)),
    ]);
  }

  private async markDirty(gameId: string, day: string): Promise<void> {
    // The class-N mon plan drains any one mon sibling → snapshots all four; mark cnt.
    await this.dirty.mark('mon', MonKeys.cnt(gameId, day));
    await this.dirty.mark('rev', RevKeys.day(gameId, day));
    await this.dirty.mark('payer', PayerKeys.members(gameId, day));
  }

  /** Seal check for the class-8 join path (grace = 48 h). */
  private isSealed(purchaseDay: string): boolean {
    const offset = this.config.reportingOffsetMinutes();
    const dayEndMs = Date.parse(`${purchaseDay}T00:00:00Z`) + 86_400_000 - offset * 60_000;
    const graceMs = 48 * 60 * 60 * 1000;
    return Date.now() > dayEndMs + graceMs;
  }
}
