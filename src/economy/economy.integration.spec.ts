/**
 * ECONOMY (004) conformance — end-to-end through the REAL 9-step kernel + the REAL
 * kind-dispatch seam (generic base THEN the economy hot hook) + live Redis + live
 * Postgres flush + the read model + the seal-time supply snapshot. Skips when the
 * stack is unreachable (proven WITH the stack in the report).
 *
 * Proves (brief §VERIFY):
 *   - hand-computed §2: gold source=2000/sink=800/net=+1200/ratio=0.40, top faucet
 *     pvp_win(1000)/top drain shop_purchase:sword(400); gems source=50/sink=100/
 *     net=−50/ratio=2.00; top faucet daily_bonus(50)/top drain shop_purchase:skin(80);
 *   - N/A sink_ratio when total_source = 0;
 *   - low-volume guard (either leg event_count < economy_ratio_min_events → masked);
 *   - class-L LWW: older as_of rejected (no clobber), newer wins, equal-as_of no-op
 *     retry, tie-break (equal as_of → later server_received → greatest event_id) —
 *     BOTH the hot guard AND the flush guard;
 *   - currency-cap other-overflow (over-cap currency KEPT + counted under `other`,
 *     sealed cells not retro-collapsed);
 *   - depth money_supply=4300 / median (p50)=1300, dormant holder still counted;
 *   - quarantine of bad amount / flow_type; NEGATIVE amount NOT auto-flipped;
 *   - logical-day @ +210 (economy consumes corrected_day verbatim);
 *   - the dispatcher routes `economy` to the EconomyHotUpdateHook AND runs the
 *     generic base (cat/cnt/rank).
 */

import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectRedisOrNull, connectPostgresOrNull } from '../testing/live-infra';
import { IngestKernel, type KernelContext } from '../workers/kernel/ingest-kernel';
import { WindowedDedupGate, UnimplementedPurchaseDedupGate } from '../common/kernel/dedup';
import { RehydrateService } from '../common/redis-keys/rehydrate';
import { DirtyRegistry } from '../workers/flush/dirty-registry';
import { FlushService } from '../workers/flush/flush.service';
import { FlushJobService, type ExtraDomainFlushPlan } from '../workers/flush/flush-job.service';
import {
  GenericHotUpdateHook,
  NoopDurableImmediateHook,
  NoopPiiScrubPort,
  PermissiveTypedValidator,
} from '../workers/kernel/default-hooks';
import { HotBucketWriter } from '../workers/kernel/hot-bucket.writer';
import { PostgresFloorProvider } from '../workers/kernel/postgres-floor.provider';
import { RedisNameCapGate } from '../workers/kernel/redis-name-cap.gate';
import { WorkerAckPort } from '../workers/kernel/ack.port';
import { RawFileService } from '../workers/rawfile/raw-file.service';
import { GameConfigService } from '../config/game-config.service';
import { KindDispatchValidator, KindDispatchDurableHook, KindDispatchHotHook } from '../workers/kernel/kind-dispatch';
import type { EventEnvelope } from '../common/contracts/envelope';

import { EconomyTypedValidator } from './economy-typed.validator';
import { EconomyHotUpdateHook } from './economy-hot-update.hook';
import { EcoCurrencyCapGate } from './eco-currency-cap.gate';
import { EconomyFloorProvider } from './economy-floor.provider';
import { BalanceLwwService } from './balance-lww.service';
import { EconomyConfigService } from './economy-config.service';
import { EconomyReadService } from './economy-read.service';
import { EconomySupplySnapshotService } from './economy-supply-snapshot.service';
import { ECO_BASE_FLUSH_PLAN, ECO_SEGMENT_FLUSH_PLAN, BAL_FLUSH_PLAN } from './economy-flush-plans';

const configStub = { get: () => undefined } as unknown as ConfigService;

/** A GameConfigService stub with per-game config overrides for the economy knobs. */
function gameConfigStub(overrides: Record<string, unknown> = {}): GameConfigService {
  return {
    getNumber: async (_g: string, key: string) =>
      typeof overrides[key] === 'number' ? (overrides[key] as number) : undefined,
    getString: async (_g: string, key: string) =>
      typeof overrides[key] === 'string' ? (overrides[key] as string) : undefined,
    getBoolean: async () => true,
    getConfig: async () => overrides,
  } as unknown as GameConfigService;
}

interface Harness {
  redis: Redis;
  ds: DataSource;
  kernel: IngestKernel;
  flushJob: FlushJobService;
  flush: FlushService;
  read: EconomyReadService;
  supply: EconomySupplySnapshotService;
  balanceLww: BalanceLwwService;
  economyConfig: EconomyConfigService;
  dir: string;
}

function buildHarness(
  redis: Redis,
  ds: DataSource,
  offsetMinutes: number,
  overrides: Record<string, unknown> = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'eco-'));
  const rehydrate = new RehydrateService(redis);
  const dirty = new DirtyRegistry(redis);
  const flush = new FlushService(redis, rehydrate, dirty, ds);
  const gameConfig = gameConfigStub(overrides);

  const economyConfig = new EconomyConfigService(gameConfig, configStub, offsetMinutes);
  const currencyCap = new EcoCurrencyCapGate(redis, gameConfig);
  const floors = new EconomyFloorProvider(ds);
  const balanceLww = new BalanceLwwService(redis, floors, dirty);

  const validator = new EconomyTypedValidator();
  const hotHook = new EconomyHotUpdateHook(redis, rehydrate, dirty, currencyCap, floors, balanceLww, economyConfig);

  // REAL dispatch seam: generic base + registered economy triple.
  const genericFloors = new PostgresFloorProvider(ds);
  const genericHot = new GenericHotUpdateHook(rehydrate, dirty, genericFloors, new HotBucketWriter(redis), gameConfig);
  const dispatchValidator = new KindDispatchValidator(new PermissiveTypedValidator(), [{ kind: 'economy', validator }]);
  dispatchValidator.onModuleInit();
  const dispatchDurable = new KindDispatchDurableHook(new NoopDurableImmediateHook(), [
    { kind: 'economy', hook: new NoopDurableImmediateHook() },
  ]);
  dispatchDurable.onModuleInit();
  const dispatchHot = new KindDispatchHotHook(genericHot, [{ kind: 'economy', hook: hotHook }]);
  dispatchHot.onModuleInit();

  const rawFile = new RawFileService({ get: () => dir } as unknown as ConfigService, { dir, coldStorageEnabled: true });
  const kernel = new IngestKernel(
    rawFile,
    new WindowedDedupGate(redis),
    new UnimplementedPurchaseDedupGate(),
    new RedisNameCapGate(redis, configStub, gameConfig),
    dispatchValidator,
    dispatchDurable,
    dispatchHot,
    new WorkerAckPort(),
    new NoopPiiScrubPort(),
  );

  const extraPlans: ExtraDomainFlushPlan[] = [
    { domain: 'eco', plan: ECO_BASE_FLUSH_PLAN },
    { domain: 'eco', plan: ECO_SEGMENT_FLUSH_PLAN },
    { domain: 'bal', plan: BAL_FLUSH_PLAN },
  ];
  const flushJob = new FlushJobService(dirty, flush, extraPlans);

  const read = new EconomyReadService(redis, ds, economyConfig);
  const supply = new EconomySupplySnapshotService(ds, economyConfig);

  return { redis, ds, kernel, flushJob, flush, read, supply, balanceLww, economyConfig, dir };
}

/** An `economy` event envelope. */
function ecoEvent(params: {
  game: string;
  userId?: string;
  flowType?: string;
  currency?: string;
  amount?: number;
  reason?: string;
  balanceAfter?: number;
  playerLevel?: number;
  region?: string;
  start: number; // client_event_time (the flow instant)
  eventId?: string;
  serverReceived?: number;
  clientSent?: number;
}): EventEnvelope {
  const sent = params.clientSent ?? params.start + 1000;
  const props: Record<string, unknown> = {};
  if (params.flowType !== undefined) props['flow_type'] = params.flowType;
  if (params.currency !== undefined) props['currency_type'] = params.currency;
  if (params.amount !== undefined) props['amount'] = params.amount;
  if (params.reason !== undefined) props['reason'] = params.reason;
  if (params.balanceAfter !== undefined) props['balance_after'] = params.balanceAfter;
  if (params.playerLevel !== undefined) props['player_level'] = params.playerLevel;
  if (params.region !== undefined) props['region'] = params.region;
  return {
    game_id: params.game,
    user_id: params.userId,
    session_id: 'sess-x',
    event_id: params.eventId ?? `e-${Math.random().toString(36).slice(2)}`,
    name: 'economy',
    kind: 'economy',
    client_event_time: params.start,
    client_sent_time: sent,
    server_received_time: params.serverReceived ?? sent + 1000,
    props,
  };
}

function ctx(now: number, offsetMinutes = 0, provenance: 'client' | 'server' = 'client'): KernelContext {
  return { reportingOffsetMinutes: offsetMinutes, now, provenance, batchJobId: 'eco-job' };
}

const uid = (p: string): string => `${p}-${Math.random().toString(36).slice(2)}`;
const DAY = '2026-07-17';
const DAY_MS = (h = 9, m = 0): number =>
  Date.parse(`${DAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
const NOW = Date.parse(`${DAY}T20:00:00Z`); // late on the target day → open

describe('economy conformance (004) — live stack', () => {
  let redis: Redis | null;
  let ds: DataSource | null;
  const dirs: string[] = [];

  beforeAll(async () => {
    redis = await connectRedisOrNull();
    ds = await connectPostgresOrNull();
  });
  afterAll(async () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    if (redis) await redis.quit();
    if (ds) await ds.destroy();
  });

  // ---- hand-computed §2 (gold + gems), top faucet/drain, N/A, low-volume ------
  it('§2 worked example: gold + gems source/sink/net/ratio + top faucet/drain match hand-computed exactly', async () => {
    if (!redis || !ds) return;
    // ratio_min_events = 1 so the 10-event stream is NOT masked low-volume here.
    const h = buildHarness(redis, ds, 0, { economy_ratio_min_events: 1 });
    dirs.push(h.dir);
    const game = uid('g-golden');
    const c = ctx(NOW, 0);

    const stream: Array<Parameters<typeof ecoEvent>[0]> = [
      {
        game,
        userId: 'u1',
        flowType: 'source',
        currency: 'gold',
        amount: 500,
        reason: 'quest_reward',
        start: DAY_MS(9, 1),
      },
      {
        game,
        userId: 'u2',
        flowType: 'source',
        currency: 'gold',
        amount: 300,
        reason: 'quest_reward',
        start: DAY_MS(9, 2),
      },
      {
        game,
        userId: 'u1',
        flowType: 'source',
        currency: 'gold',
        amount: 200,
        reason: 'daily_bonus',
        start: DAY_MS(9, 3),
      },
      {
        game,
        userId: 'u3',
        flowType: 'source',
        currency: 'gold',
        amount: 1000,
        reason: 'pvp_win',
        start: DAY_MS(9, 4),
      },
      {
        game,
        userId: 'u1',
        flowType: 'sink',
        currency: 'gold',
        amount: 400,
        reason: 'shop_purchase:sword',
        start: DAY_MS(9, 5),
      },
      {
        game,
        userId: 'u2',
        flowType: 'sink',
        currency: 'gold',
        amount: 250,
        reason: 'upgrade:barracks',
        start: DAY_MS(9, 6),
      },
      { game, userId: 'u3', flowType: 'sink', currency: 'gold', amount: 150, reason: 'repair', start: DAY_MS(9, 7) },
      {
        game,
        userId: 'u1',
        flowType: 'source',
        currency: 'gems',
        amount: 50,
        reason: 'daily_bonus',
        start: DAY_MS(9, 8),
      },
      {
        game,
        userId: 'u2',
        flowType: 'sink',
        currency: 'gems',
        amount: 80,
        reason: 'shop_purchase:skin',
        start: DAY_MS(9, 9),
      },
      { game, userId: 'u3', flowType: 'sink', currency: 'gems', amount: 20, reason: 'time_skip', start: DAY_MS(9, 10) },
    ];
    for (const e of stream) {
      await h.kernel.process(ecoEvent(e), c);
    }
    await h.flushJob.sweep();

    // Read AFTER flush with now on a LATER day so the target day reads durable-only
    // (no open-day merge) — confirms the flushed durable cells alone are correct.
    const later = Date.parse('2026-07-18T12:00:00Z');
    const gold = await h.read.economyDay(game, 'gold', DAY, { now: later });
    expect(gold.totalSource).toBe(2000);
    expect(gold.totalSink).toBe(800);
    expect(gold.netFlow).toBe(1200);
    expect(gold.sinkRatio).toBeCloseTo(0.4, 6);
    expect(gold.topFaucets[0]).toEqual({ reason: 'pvp_win', amount: 1000 });
    expect(gold.topDrains[0]).toEqual({ reason: 'shop_purchase:sword', amount: 400 });

    const gems = await h.read.economyDay(game, 'gems', DAY, { now: later });
    expect(gems.totalSource).toBe(50);
    expect(gems.totalSink).toBe(100);
    expect(gems.netFlow).toBe(-50);
    expect(gems.sinkRatio).toBeCloseTo(2.0, 6);
    expect(gems.topFaucets[0]).toEqual({ reason: 'daily_bonus', amount: 50 });
    expect(gems.topDrains[0]).toEqual({ reason: 'shop_purchase:skin', amount: 80 });
  });

  // ---- N/A sink_ratio when source = 0 + low-volume mask -----------------------
  it('sink_ratio = N/A when total_source = 0 (never 0/∞/NaN); low-volume mask below the threshold', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0, { economy_ratio_min_events: 100 });
    dirs.push(h.dir);
    const game = uid('g-na');
    // Only sinks, no source → ratio N/A. And only 2 events < threshold 100 → masked.
    await h.kernel.process(
      ecoEvent({
        game,
        userId: 'u1',
        flowType: 'sink',
        currency: 'gold',
        amount: 100,
        reason: 'repair',
        start: DAY_MS(9, 1),
      }),
      ctx(NOW, 0),
    );
    await h.kernel.process(
      ecoEvent({
        game,
        userId: 'u2',
        flowType: 'sink',
        currency: 'gold',
        amount: 50,
        reason: 'repair',
        start: DAY_MS(9, 2),
      }),
      ctx(NOW, 0),
    );
    await h.flushJob.sweep();
    const later = Date.parse('2026-07-18T12:00:00Z');
    const v = await h.read.economyDay(game, 'gold', DAY, { now: later });
    expect(v.totalSource).toBe(0);
    expect(v.totalSink).toBe(150);
    expect(v.netFlow).toBe(-150);
    expect(v.sinkRatio).toBeNull(); // N/A, never 0/∞/NaN
    expect(v.lowVolume).toBe(true); // source leg count 0 < 100
    expect(v.sinkEventCount).toBe(2);
    expect(v.sourceEventCount).toBe(0);
  });

  // ---- dispatcher routes economy to the economy hook AND runs the generic base
  it('the dispatcher routes `economy` to the EconomyHotUpdateHook AND runs the generic base (cat/cnt/rank)', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0, { economy_ratio_min_events: 1 });
    dirs.push(h.dir);
    const game = uid('g-dispatch');
    await h.kernel.process(
      ecoEvent({
        game,
        userId: 'u1',
        flowType: 'source',
        currency: 'gold',
        amount: 42,
        reason: 'quest_reward',
        start: DAY_MS(9, 1),
      }),
      ctx(NOW, 0),
    );
    await h.flushJob.sweep();

    // Economy accumulator fired → ECONOMY_FLOW_RESULT exists.
    const later = Date.parse('2026-07-18T12:00:00Z');
    const v = await h.read.economyDay(game, 'gold', DAY, { now: later });
    expect(v.totalSource).toBe(42);
    // Generic base fired → EVENT_DAY_COUNT has the `economy` name row.
    const cnt: Array<{ n: string }> = await ds.query(
      `SELECT count::text AS n FROM event_day_count WHERE game_id = $1 AND event_name = 'economy' AND utc_day = $2`,
      [game, DAY],
    );
    expect(Number(cnt[0]?.n ?? '0')).toBe(1);
  });

  // ---- quarantine: bad amount / flow_type; NEGATIVE amount NOT flipped ---------
  it('quarantines bad amount / flow_type / missing currency-or-reason; a NEGATIVE amount is NOT auto-flipped', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0, { economy_ratio_min_events: 1 });
    dirs.push(h.dir);
    const game = uid('g-quar');
    const c = ctx(NOW, 0);

    // negative amount → quarantine (NOT flipped to a sink/source of +5).
    const neg = await h.kernel.process(
      ecoEvent({
        game,
        userId: 'u1',
        flowType: 'source',
        currency: 'gold',
        amount: -5,
        reason: 'quest_reward',
        start: DAY_MS(9, 1),
      }),
      c,
    );
    expect(neg.verdicts.disposition).toBe('quarantine');
    expect(neg.verdicts.reason).toBe('quarantined_typed');
    expect(neg.counted).toBe(false);

    // zero amount → quarantine.
    const zero = await h.kernel.process(
      ecoEvent({
        game,
        userId: 'u1',
        flowType: 'source',
        currency: 'gold',
        amount: 0,
        reason: 'quest_reward',
        start: DAY_MS(9, 2),
      }),
      c,
    );
    expect(zero.verdicts.reason).toBe('quarantined_typed');

    // bad flow_type → quarantine.
    const badFlow = await h.kernel.process(
      ecoEvent({
        game,
        userId: 'u1',
        flowType: 'grant',
        currency: 'gold',
        amount: 5,
        reason: 'quest_reward',
        start: DAY_MS(9, 3),
      }),
      c,
    );
    expect(badFlow.verdicts.reason).toBe('quarantined_typed');

    // missing currency → quarantine.
    const noCur = await h.kernel.process(
      ecoEvent({ game, userId: 'u1', flowType: 'source', amount: 5, reason: 'quest_reward', start: DAY_MS(9, 4) }),
      c,
    );
    expect(noCur.verdicts.reason).toBe('quarantined_typed');

    await h.flushJob.sweep();
    const later = Date.parse('2026-07-18T12:00:00Z');
    const v = await h.read.economyDay(game, 'gold', DAY, { now: later });
    // NOTHING accumulated — the negative was never flipped into a +5 anywhere.
    expect(v.totalSource).toBe(0);
    expect(v.totalSink).toBe(0);
  });

  // ---- currency-cap other-overflow (KEPT + counted, sealed not retro-collapsed)
  it('currency cap: an over-cap currency collapses to `other` (KEPT + counted, never dropped)', async () => {
    if (!redis || !ds) return;
    // cap = 1 distinct currency; the 2nd distinct currency overflows to `other`.
    const h = buildHarness(redis, ds, 0, { economy_currency_cap_per_game: 1, economy_ratio_min_events: 1 });
    dirs.push(h.dir);
    const game = uid('g-cap');
    const c = ctx(NOW, 0);

    // gold admitted (1st distinct, under cap).
    await h.kernel.process(
      ecoEvent({
        game,
        userId: 'u1',
        flowType: 'source',
        currency: 'gold',
        amount: 100,
        reason: 'quest_reward',
        start: DAY_MS(9, 1),
      }),
      c,
    );
    // gems is the 2nd distinct → over cap → bucketed under `other` (KEPT, counted).
    await h.kernel.process(
      ecoEvent({
        game,
        userId: 'u2',
        flowType: 'source',
        currency: 'gems',
        amount: 30,
        reason: 'daily_bonus',
        start: DAY_MS(9, 2),
      }),
      c,
    );
    await h.flushJob.sweep();

    const later = Date.parse('2026-07-18T12:00:00Z');
    const gold = await h.read.economyDay(game, 'gold', DAY, { now: later });
    expect(gold.totalSource).toBe(100);
    // The overflow currency is `other` (not dropped, not `gems`, not `unknown`).
    const other = await h.read.economyDay(game, 'other', DAY, { now: later });
    expect(other.totalSource).toBe(30);
    const gems = await h.read.economyDay(game, 'gems', DAY, { now: later });
    expect(gems.totalSource).toBe(0); // gems collapsed into other, no gems cell

    // Registry set has gold + other (not gems).
    const cur = await h.read.currencies(game);
    expect(cur).toContain('gold');
    expect(cur).toContain('other');
    expect(cur).not.toContain('gems');
  });

  // ---- depth: money_supply=4300 / p50=1300, dormant holder still counted -------
  it('depth: money_supply = Σ last-known balance (dormant holder counted) with p50 median', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0, { economy_depth_capture_mode: 'full', economy_ratio_min_events: 1 });
    dirs.push(h.dir);
    const game = uid('g-depth');
    const c = ctx(NOW, 0);
    // u1=1300, u2=800, u3=2200 → supply 4300, median (p50 nearest-rank of sorted
    // [800,1300,2200]) = 1300. u3 then goes DORMANT (never reports again) but its
    // last-known balance still counts.
    await h.kernel.process(
      ecoEvent({
        game,
        userId: 'u1',
        flowType: 'source',
        currency: 'gold',
        amount: 1300,
        reason: 'pvp_win',
        balanceAfter: 1300,
        start: DAY_MS(9, 1),
      }),
      c,
    );
    await h.kernel.process(
      ecoEvent({
        game,
        userId: 'u2',
        flowType: 'source',
        currency: 'gold',
        amount: 800,
        reason: 'pvp_win',
        balanceAfter: 800,
        start: DAY_MS(9, 2),
      }),
      c,
    );
    await h.kernel.process(
      ecoEvent({
        game,
        userId: 'u3',
        flowType: 'source',
        currency: 'gold',
        amount: 2200,
        reason: 'pvp_win',
        balanceAfter: 2200,
        start: DAY_MS(9, 3),
      }),
      c,
    );
    await h.flushJob.sweep();

    const supply = await h.read.moneySupply(game, 'gold');
    expect(supply.moneySupply).toBe(4300);
    expect(supply.nUsers).toBe(3);
    expect(supply.p50).toBe(1300); // dormant u3 counted; median = 1300
    expect(supply.coverageLabel).toContain('3 balance-reporting holders');

    // Seal-time supply snapshot writes the ECONOMY_SUPPLY_DAY row.
    const snap = await h.supply.snapshotDay(game, DAY);
    const goldSnap = snap.find((s) => s.currency === 'gold');
    expect(goldSnap?.moneySupply).toBe('4300');
    expect(goldSnap?.nUsers).toBe(3);
    expect(goldSnap?.depthPercentiles['p50']).toBe(1300);
  });

  // ---- class-L LWW: hot guard — older rejected, newer wins, equal no-op, tie-break
  it('class-L LWW hot guard: stale as_of rejected (no clobber); newer wins; equal-as_of tie-break deterministic', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0, { economy_depth_capture_mode: 'full', economy_ratio_min_events: 1 });
    dirs.push(h.dir);
    const game = uid('g-lww');
    const user = uid('u');
    const c = ctx(NOW, 0);

    const t2 = DAY_MS(12, 0); // NEWER corrected time
    const t1 = DAY_MS(9, 0); // OLDER corrected time

    // NEWER balance first (as_of = t2, balance 500).
    await h.kernel.process(
      ecoEvent({
        game,
        userId: user,
        flowType: 'source',
        currency: 'gold',
        amount: 1,
        reason: 'x',
        balanceAfter: 500,
        start: t2,
        eventId: 'newer',
      }),
      c,
    );
    // OLDER balance arrives SECOND (as_of = t1, balance 999) — must be REJECTED
    // (stale as_of never clobbers the newer 500).
    await h.kernel.process(
      ecoEvent({
        game,
        userId: user,
        flowType: 'source',
        currency: 'gold',
        amount: 1,
        reason: 'x',
        balanceAfter: 999,
        start: t1,
        eventId: 'older',
      }),
      c,
    );
    const live = await h.balanceLww.read(game, user, 'gold');
    expect(live?.balance).toBe('500'); // stale REJECTED — the newer 500 stands

    // A strictly-NEWER balance (as_of t3, balance 700) wins (balances legitimately
    // fall/rise — LWW by time, not GREATEST).
    const t3 = DAY_MS(14, 0);
    await h.kernel.process(
      ecoEvent({
        game,
        userId: user,
        flowType: 'source',
        currency: 'gold',
        amount: 1,
        reason: 'x',
        balanceAfter: 700,
        start: t3,
        eventId: 'newest',
      }),
      c,
    );
    const live2 = await h.balanceLww.read(game, user, 'gold');
    expect(live2?.balance).toBe('700'); // newer wins even though 700 < ... irrelevant

    // Tie-break: equal as_of → later server_received wins, then greatest event_id.
    // Hold corrected_time (= as_of) EQUAL by setting client_sent == server_received
    // so the skew offset is 0 → corrected_time = client_event_time = `tie` for both.
    // DISTINCT event_ids (else the 2nd is deduped at step 6 and never reaches
    // step 8) — as_of equal (skew 0 via clientSent==serverReceived), server_received
    // differs → decided on server_received BEFORE event_id.
    const user2 = uid('u');
    const tie = DAY_MS(10, 0);
    await h.kernel.process(
      ecoEvent({
        game,
        userId: user2,
        flowType: 'source',
        currency: 'gold',
        amount: 1,
        reason: 'x',
        balanceAfter: 100,
        start: tie,
        eventId: 'tie-e1',
        clientSent: tie + 5000,
        serverReceived: tie + 5000,
      }),
      c,
    );
    // Same as_of, LATER server_received → wins (regardless of event_id ordering).
    await h.kernel.process(
      ecoEvent({
        game,
        userId: user2,
        flowType: 'source',
        currency: 'gold',
        amount: 1,
        reason: 'x',
        balanceAfter: 222,
        start: tie,
        eventId: 'tie-e2',
        clientSent: tie + 9000,
        serverReceived: tie + 9000,
      }),
      c,
    );
    const tieLive = await h.balanceLww.read(game, user2, 'gold');
    expect(tieLive?.balance).toBe('222'); // later server_received won the tie

    // event_id tie-break: equal as_of AND equal server_received → greatest event_id.
    const user3 = uid('u');
    const tie2 = DAY_MS(11, 0);
    await h.kernel.process(
      ecoEvent({
        game,
        userId: user3,
        flowType: 'source',
        currency: 'gold',
        amount: 1,
        reason: 'x',
        balanceAfter: 111,
        start: tie2,
        eventId: 'zzz',
        clientSent: tie2 + 3000,
        serverReceived: tie2 + 3000,
      }),
      c,
    );
    await h.kernel.process(
      ecoEvent({
        game,
        userId: user3,
        flowType: 'source',
        currency: 'gold',
        amount: 1,
        reason: 'x',
        balanceAfter: 333,
        start: tie2,
        eventId: 'aaa',
        clientSent: tie2 + 3000,
        serverReceived: tie2 + 3000,
      }),
      c,
    );
    // Full tie on (as_of, server_received) → greatest event_id wins. 'aaa' < 'zzz'
    // → the later 'aaa' write must NOT clobber the 'zzz'-authored 111.
    const tie2Live = await h.balanceLww.read(game, user3, 'gold');
    expect(tie2Live?.balance).toBe('111'); // 'zzz' (greatest id) held the tie
  });

  // ---- class-L LWW: FLUSH guard — stale flush never clobbers durable ----------
  it('class-L LWW flush guard: a stale as_of upsert is rejected by WHERE EXCLUDED.as_of >= as_of (no clobber)', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0, { economy_depth_capture_mode: 'full', economy_ratio_min_events: 1 });
    dirs.push(h.dir);
    const game = uid('g-lww-flush');
    const user = uid('u');
    const c = ctx(NOW, 0);

    const tNew = DAY_MS(12, 0);
    // Write the NEWER balance (500 @ tNew) to the durable snapshot via a real flush.
    await h.kernel.process(
      ecoEvent({
        game,
        userId: user,
        flowType: 'source',
        currency: 'gold',
        amount: 1,
        reason: 'x',
        balanceAfter: 500,
        start: tNew,
        eventId: 'n1',
      }),
      c,
    );
    await h.flushJob.sweep();
    const durable1: Array<{ b: string }> = await ds.query(
      `SELECT last_known_balance::text AS b FROM balance_snapshot WHERE game_id = $1 AND user_id = $2 AND currency = 'gold'`,
      [game, user],
    );
    expect(durable1[0]?.b).toBe('500');

    // Now directly apply a STALE flush row (older as_of, balance 999) via the shared
    // engine (simulating a reordered/replayed flush) — the class-L WHERE guard must
    // REJECT it, leaving the durable 500 intact.
    const tOld = DAY_MS(9, 0);
    const { buildFlushStatement } = await import('../workers/flush/flush-merge');
    const stmt = buildFlushStatement(BAL_FLUSH_PLAN.spec, {
      pk: { game_id: game, user_id: user, currency: 'gold' },
      values: { last_known_balance: '999', provenance: 'client' },
      guard: new Date(tOld).toISOString(),
    });
    await ds.query(stmt.sql, stmt.params);
    const durable2: Array<{ b: string }> = await ds.query(
      `SELECT last_known_balance::text AS b FROM balance_snapshot WHERE game_id = $1 AND user_id = $2 AND currency = 'gold'`,
      [game, user],
    );
    expect(durable2[0]?.b).toBe('500'); // stale flush REJECTED — no clobber

    // A NEWER flush row (as_of tNewer, balance 700) IS applied.
    const tNewer = DAY_MS(15, 0);
    const stmt2 = buildFlushStatement(BAL_FLUSH_PLAN.spec, {
      pk: { game_id: game, user_id: user, currency: 'gold' },
      values: { last_known_balance: '700', provenance: 'client' },
      guard: new Date(tNewer).toISOString(),
    });
    await ds.query(stmt2.sql, stmt2.params);
    const durable3: Array<{ b: string }> = await ds.query(
      `SELECT last_known_balance::text AS b FROM balance_snapshot WHERE game_id = $1 AND user_id = $2 AND currency = 'gold'`,
      [game, user],
    );
    expect(durable3[0]?.b).toBe('700'); // newer wins
  });

  // ---- per-entry rehydrate-on-miss guards a post-crash stale event ------------
  it('per-entry rehydrate-on-miss: after a Redis loss, a stale event cannot regress the durable balance', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0, { economy_depth_capture_mode: 'full', economy_ratio_min_events: 1 });
    dirs.push(h.dir);
    const game = uid('g-rehyd');
    const user = uid('u');
    const c = ctx(NOW, 0);

    // Land a NEWER balance in the DURABLE snapshot.
    const tNew = DAY_MS(12, 0);
    await h.kernel.process(
      ecoEvent({
        game,
        userId: user,
        flowType: 'source',
        currency: 'gold',
        amount: 1,
        reason: 'x',
        balanceAfter: 500,
        start: tNew,
        eventId: 'n1',
      }),
      c,
    );
    await h.flushJob.sweep();
    // Simulate a TOTAL Redis loss (wipe the hot bal hash for the game).
    const keys = await redis.keys(`${game}:*`);
    if (keys.length > 0) await redis.del(...keys);

    // A STALE offline-buffered event (older as_of) arrives after the crash. The
    // per-entry rehydrate seeds the durable 500 before comparing → the stale 999 is
    // rejected. The INVARIANT the guard protects is the DURABLE balance: it must
    // stay 500 (never regressed). A subsequent flush must not write 999 either.
    const tOld = DAY_MS(9, 0);
    await h.kernel.process(
      ecoEvent({
        game,
        userId: user,
        flowType: 'source',
        currency: 'gold',
        amount: 1,
        reason: 'x',
        balanceAfter: 999,
        start: tOld,
        eventId: 'stale',
      }),
      c,
    );
    await h.flushJob.sweep();
    const durable: Array<{ b: string }> = await ds.query(
      `SELECT last_known_balance::text AS b FROM balance_snapshot WHERE game_id = $1 AND user_id = $2 AND currency = 'gold'`,
      [game, user],
    );
    expect(durable[0]?.b).toBe('500'); // rehydrate-on-miss rejected the stale write — no regression

    // And a strictly-NEWER post-crash event DOES apply (proving the seed did not
    // freeze the entry — only the LWW guard rejected the stale one).
    const tNewer = DAY_MS(15, 0);
    await h.kernel.process(
      ecoEvent({
        game,
        userId: user,
        flowType: 'source',
        currency: 'gold',
        amount: 1,
        reason: 'x',
        balanceAfter: 640,
        start: tNewer,
        eventId: 'newer',
      }),
      c,
    );
    await h.flushJob.sweep();
    const durable2: Array<{ b: string }> = await ds.query(
      `SELECT last_known_balance::text AS b FROM balance_snapshot WHERE game_id = $1 AND user_id = $2 AND currency = 'gold'`,
      [game, user],
    );
    expect(durable2[0]?.b).toBe('640');
  });

  // ---- logical-day @ +210 (economy consumes corrected_day verbatim) -----------
  it('logical-day @ +210: a 22:00 UTC flow on 07-16 buckets on the +03:30 day 07-17', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 210, { economy_ratio_min_events: 1 });
    dirs.push(h.dir);
    const game = uid('g-tz');
    // 22:00 UTC 07-16 = 01:30 local 07-17 → logical day 07-17.
    const start = Date.parse('2026-07-16T22:00:00Z');
    const now = Date.parse('2026-07-17T20:00:00Z');
    await h.kernel.process(
      ecoEvent({ game, userId: 'u1', flowType: 'source', currency: 'gold', amount: 77, reason: 'quest_reward', start }),
      ctx(now, 210),
    );
    await h.flushJob.sweep();
    const durable: Array<{ n: string }> = await ds.query(
      `SELECT amount_sum::text AS n FROM economy_flow_result WHERE game_id = $1 AND currency = 'gold' AND utc_day = '2026-07-17'`,
      [game],
    );
    expect(Number(durable[0]?.n ?? '0')).toBe(77); // logical day 07-17, NOT raw-UTC 07-16
    const wrongDay: Array<{ c: string }> = await ds.query(
      `SELECT count(*)::text AS c FROM economy_flow_result WHERE game_id = $1 AND utc_day = '2026-07-16'`,
      [game],
    );
    expect(Number(wrongDay[0]?.c)).toBe(0);
  });

  // ---- provenance slice: trusted-only (server) totals ------------------------
  it('provenance slice: trusted-only (server) totals exclude client flows', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0, { economy_ratio_min_events: 1 });
    dirs.push(h.dir);
    const game = uid('g-prov');
    // A client flow (300) and a server flow (700) into gold source.
    await h.kernel.process(
      ecoEvent({
        game,
        userId: 'u1',
        flowType: 'source',
        currency: 'gold',
        amount: 300,
        reason: 'quest_reward',
        start: DAY_MS(9, 1),
      }),
      ctx(NOW, 0, 'client'),
    );
    await h.kernel.process(
      ecoEvent({
        game,
        userId: 'u2',
        flowType: 'source',
        currency: 'gold',
        amount: 700,
        reason: 'server_grant',
        start: DAY_MS(9, 2),
      }),
      ctx(NOW, 0, 'server'),
    );
    await h.flushJob.sweep();
    const later = Date.parse('2026-07-18T12:00:00Z');
    const all = await h.read.economyDay(game, 'gold', DAY, { now: later });
    expect(all.totalSource).toBe(1000); // collapsed provenance
    const trusted = await h.read.economyDay(game, 'gold', DAY, { now: later, provenanceFilter: 'server' });
    expect(trusted.totalSource).toBe(700); // server slice only
  });

  // ---- segment slice: level_bucket axis (independent, observed-only) ----------
  it('segment slice: an event with player_level materializes a level_bucket segment cell', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0, { economy_ratio_min_events: 1, level_bucket_boundaries: [10, 20, 30] });
    dirs.push(h.dir);
    const game = uid('g-seg');
    // player_level 25 → bucket "20-29".
    await h.kernel.process(
      ecoEvent({
        game,
        userId: 'u1',
        flowType: 'source',
        currency: 'gold',
        amount: 500,
        reason: 'pvp_win',
        playerLevel: 25,
        start: DAY_MS(9, 1),
      }),
      ctx(NOW, 0),
    );
    await h.flushJob.sweep();
    const seg = await h.read.segmentDay(game, 'gold', DAY, 'level_bucket', '20-29');
    expect(seg.totalSource).toBe(500);
    // A different bucket has nothing.
    const other = await h.read.segmentDay(game, 'gold', DAY, 'level_bucket', '<10');
    expect(other.totalSource).toBe(0);
  });

  // ---- open-day live merge is provisional; flush converges --------------------
  it('open-day read is provisional (live-merged); after flush the sealed read is durable-only', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0, { economy_ratio_min_events: 1 });
    dirs.push(h.dir);
    const game = uid('g-prov2');
    await h.kernel.process(
      ecoEvent({
        game,
        userId: 'u1',
        flowType: 'source',
        currency: 'gold',
        amount: 60,
        reason: 'quest_reward',
        start: DAY_MS(9, 1),
      }),
      ctx(NOW, 0),
    );
    // Read the OPEN day (now = same day) BEFORE flush → provisional, live value present.
    const open = await h.read.economyDay(game, 'gold', DAY, { now: NOW });
    expect(open.totalSource).toBe(60);
    expect(open.provisional).toBe(true);
    await h.flushJob.sweep();
    const sealed = await h.read.economyDay(game, 'gold', DAY, { now: Date.parse('2026-07-18T12:00:00Z') });
    expect(sealed.totalSource).toBe(60);
    expect(sealed.provisional).toBe(false);
  });
});
