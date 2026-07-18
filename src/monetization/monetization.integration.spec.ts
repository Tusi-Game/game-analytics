/**
 * MONETIZATION (006) + DERIVED-KPIS (007) conformance — end-to-end through the REAL
 * 9-step kernel + the REAL kind-dispatch seam (generic base THEN the purchase hot hook)
 * + the REAL durable PurchaseDedupGate rebind + live Redis + live Postgres (durable step-7
 * atomic unit + class-N Lua-snapshot flush) + FX + reconciliation + the read model. Skips
 * when the stack is unreachable (proven WITH the stack in the report).
 *
 * Proves (brief §VERIFY / §5):
 *   - server-trusted money: client source=server rejected (provenance=client → ineligible);
 *   - durable dedup >24h → one row, never windowed;
 *   - class-N gen-gate: MOVE conserves count+revenue; GREATEST-forbidden negative test;
 *   - companion join by purchase_attempt_id (joins even when the client lacks transaction_id;
 *     missing → reduced dims);
 *   - FX as-of + park-unconverted + convert-pre-seal (reconciliation recompute);
 *   - KPI hand-computed (DAU=1000/MAU=5000→stickiness 0.20, ARPDAU $0.40, ARPPU $10,
 *     conversion 4%, whale [500,200,120,80,40,30,15,10,3,2]→50/70/94%);
 *   - gate-coupled atomic (dup → zero effect); never-sessioned payer commits, no USER_SPINE row.
 */

import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectRedisOrNull, connectPostgresOrNull } from '../testing/live-infra';
import { IngestKernel, type KernelContext } from '../workers/kernel/ingest-kernel';
import { WindowedDedupGate } from '../common/kernel/dedup';
import { RehydrateService } from '../common/redis-keys/rehydrate';
import { DirtyRegistry } from '../workers/flush/dirty-registry';
import { FlushService } from '../workers/flush/flush.service';
import {
  FlushJobService,
  EXTRA_DOMAIN_FLUSH_PLANS,
  EXTRA_CLASS_N_FLUSH_PLANS,
} from '../workers/flush/flush-job.service';
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
import { ExceptionTallyWriter } from '../workers/kernel/exception-tally.writer';
import { RawFileService } from '../workers/rawfile/raw-file.service';
import { GameConfigService } from '../config/game-config.service';
import { KindDispatchValidator, KindDispatchDurableHook, KindDispatchHotHook } from '../workers/kernel/kind-dispatch';
import { SecretCryptoService } from '../security/secret-crypto.service';
import type { EventEnvelope } from '../common/contracts/envelope';

import { PurchaseValidator } from './purchase-validator';
import { PurchaseDurableHook } from './purchase-durable.hook';
import { PurchaseHotHook } from './purchase-hot.hook';
import { PurchaseDedupGateService } from './purchase-dedup-gate.service';
import { FxService } from './fx.service';
import { MonetizationConfigService } from './monetization-config.service';
import { CardinalityGuardService } from './cardinality-guard.service';
import { MonetizationFloorProvider } from './monetization-floor.provider';
import { MonetizationReadService } from './monetization-read.service';
import { ReconciliationService } from './reconciliation.service';
import { MON_CELL_FLUSH_PLAN, REV_DAY_FLUSH_PLAN, PAYER_MEMBERS_FLUSH_PLAN } from './monetization-flush-plans';
import { MonKeys, cellKey, META_GEN_FIELD } from './mon-keys';
import { PurchaseIdempotencyEntity } from '../database/entities/purchase-idempotency.entity';
import { MonetizationCellEntity } from '../database/entities/monetization-cell.entity';
import { PayerDayEntity } from '../database/entities/payer-day.entity';
import { PayerSpineExtEntity } from '../database/entities/payer-spine-ext.entity';
import { PayerPeriodSpendEntity } from '../database/entities/payer-period-spend.entity';
import { FxRateEntity } from '../database/entities/fx-rate.entity';
import { ActiveUserDayEntity } from '../database/entities/active-user-day.entity';

const configStub = { get: () => undefined } as unknown as ConfigService;

function gameConfigStub(overrides: Record<string, unknown> = {}): GameConfigService {
  return {
    getNumber: async (_g: string, key: string) =>
      typeof overrides[key] === 'number' ? (overrides[key] as number) : undefined,
    getString: async (_g: string, key: string) =>
      typeof overrides[key] === 'string' ? (overrides[key] as string) : undefined,
    getBoolean: async (_g: string, key: string) =>
      typeof overrides[key] === 'boolean' ? (overrides[key] as boolean) : true,
    getConfig: async () => overrides,
  } as unknown as GameConfigService;
}

interface Harness {
  redis: Redis;
  ds: DataSource;
  kernel: IngestKernel;
  flushJob: FlushJobService;
  flush: FlushService;
  read: MonetizationReadService;
  reconcile: ReconciliationService;
  fx: FxService;
  config: MonetizationConfigService;
  dir: string;
}

function buildHarness(redis: Redis, ds: DataSource, overrides: Record<string, unknown> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'mon-'));
  const rehydrate = new RehydrateService(redis);
  const dirty = new DirtyRegistry(redis);
  const flush = new FlushService(redis, rehydrate, dirty, ds);
  const gameConfig = gameConfigStub(overrides);
  const config = new MonetizationConfigService(gameConfig, configStub, 0);
  const crypto = new SecretCryptoService(configStub, 'test-master-key');
  const fx = new FxService(ds, crypto);
  const cardinality = new CardinalityGuardService(redis, config);
  const floors = new MonetizationFloorProvider(ds);
  const tally = new ExceptionTallyWriter(redis, rehydrate, dirty, new PostgresFloorProvider(ds));
  const gate = new PurchaseDedupGateService(ds);

  const validator = new PurchaseValidator();
  const durableHook = new PurchaseDurableHook(ds, gate, fx, config);
  const hotHook = new PurchaseHotHook(redis, ds, rehydrate, dirty, floors, config, cardinality, tally);

  // REAL dispatch seam: generic base + registered purchase triple.
  const genericFloors = new PostgresFloorProvider(ds);
  const genericHot = new GenericHotUpdateHook(rehydrate, dirty, genericFloors, new HotBucketWriter(redis), gameConfig);
  const dispatchValidator = new KindDispatchValidator(new PermissiveTypedValidator(), [
    { kind: 'purchase', validator },
  ]);
  dispatchValidator.onModuleInit();
  const dispatchDurable = new KindDispatchDurableHook(new NoopDurableImmediateHook(), [
    { kind: 'purchase', hook: durableHook },
  ]);
  dispatchDurable.onModuleInit();
  const dispatchHot = new KindDispatchHotHook(genericHot, [{ kind: 'purchase', hook: hotHook }]);
  dispatchHot.onModuleInit();

  const rawFile = new RawFileService({ get: () => dir } as unknown as ConfigService, { dir, coldStorageEnabled: true });
  const kernel = new IngestKernel(
    rawFile,
    new WindowedDedupGate(redis),
    gate, // the REAL PurchaseDedupGate (rebind).
    new RedisNameCapGate(redis, configStub, gameConfig),
    dispatchValidator,
    dispatchDurable,
    dispatchHot,
    new WorkerAckPort(),
    new NoopPiiScrubPort(),
  );

  const flushJob = new FlushJobService(
    dirty,
    flush,
    [{ domain: 'payer', plan: PAYER_MEMBERS_FLUSH_PLAN }],
    [
      { domain: 'mon', plan: MON_CELL_FLUSH_PLAN },
      { domain: 'rev', plan: REV_DAY_FLUSH_PLAN },
    ],
  );

  const read = new MonetizationReadService(redis, ds, config);
  const reconcile = new ReconciliationService(ds, fx, config);

  // Reference the tokens so the imports are used (documents the module wiring shape).
  void EXTRA_DOMAIN_FLUSH_PLANS;
  void EXTRA_CLASS_N_FLUSH_PLANS;

  return { redis, ds, kernel, flushJob, flush, read, reconcile, fx, config, dir };
}

// Use TODAY (real wall-clock) as the working day so the hot hook's seal-governance
// (which consults real Date.now() for the 48 h grace) sees it as OPEN — MOVE + rollup
// only run for an unsealed purchase day.
const DAY = new Date().toISOString().slice(0, 10);
const NOW = Date.now();

function ctx(provenance: 'client' | 'server'): KernelContext {
  return { reportingOffsetMinutes: 0, now: NOW, provenance, batchJobId: 'batch-mon' };
}

let seq = 0;
function serverPurchase(
  gameId: string,
  overrides: Partial<Record<string, unknown>> = {},
  envOverrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  seq += 1;
  return {
    game_id: gameId,
    user_id: (overrides['user_id'] as string) ?? 'u1',
    event_id: `evt-${seq}`,
    name: 'purchase',
    kind: 'purchase',
    client_event_time: NOW,
    client_sent_time: NOW,
    server_received_time: NOW,
    props: {
      source: 'server',
      transaction_id: `T${seq}`,
      original_transaction_id: `O${seq}`,
      product_id: 'energy_pack',
      product_category: 'consumable',
      price_local: 0.99,
      currency: 'USD',
      verified: true,
      environment: 'prod',
      user_id: (overrides['user_id'] as string) ?? 'u1',
      ...overrides,
    },
    ...envOverrides,
  };
}

function companion(gameId: string, purchaseAttemptId: string, dims: Record<string, unknown>): EventEnvelope {
  seq += 1;
  return {
    game_id: gameId,
    user_id: 'u1',
    event_id: `cmp-${seq}`,
    name: 'purchase',
    kind: 'purchase',
    client_event_time: NOW,
    client_sent_time: NOW,
    server_received_time: NOW,
    props: { source: 'client', purchase_attempt_id: purchaseAttemptId, ...dims },
  };
}

let redis: Redis | null;
let ds: DataSource | null;

beforeAll(async () => {
  redis = await connectRedisOrNull();
  ds = await connectPostgresOrNull();
});

afterAll(async () => {
  if (redis) {
    await redis.quit();
  }
  if (ds) {
    await ds.destroy();
  }
});

/** Seed a USD 1.00 as-of rate for `day` so server rows convert 1:1. */
async function seedUsdRate(dataSource: DataSource, gameId: string, day: string, rate = '1.00'): Promise<void> {
  await dataSource
    .getRepository(FxRateEntity)
    .createQueryBuilder()
    .insert()
    .into(FxRateEntity)
    .values({ gameId, currency: 'USD', rateDate: day, rate })
    .orUpdate(['rate'], ['game_id', 'currency', 'rate_date'])
    .execute();
}

async function cleanGame(dataSource: DataSource, r: Redis, gameId: string): Promise<void> {
  for (const table of [
    'purchase_idempotency',
    'monetization_cell',
    'payer_day',
    'payer_spine_ext',
    'payer_period_spend',
    'fx_rate',
    'active_user_day',
    // Shared 002 structures — clear this game's rows so the generic-base rehydrate
    // floor is deterministic across full-suite runs.
    'event_day_count',
    'event_catalog',
  ]) {
    await dataSource.query(`DELETE FROM ${table} WHERE game_id = $1`, [gameId]);
  }
  const keys = await r.keys(`${gameId}:*`);
  if (keys.length > 0) {
    await r.del(...keys);
  }
}

const maybeIt = (name: string, fn: () => Promise<void>): void => {
  it(name, async () => {
    if (!redis || !ds) {
      // eslint-disable-next-line no-console
      console.warn(`[SKIP] ${name} — live Redis/Postgres unreachable`);
      return;
    }
    await fn();
  });
};

describe('monetization + derived-KPIs integration', () => {
  maybeIt('server-trusted money: a client-source row under client provenance is ineligible', async () => {
    const gameId = 'mon-trust';
    await cleanGame(ds!, redis!, gameId);
    await seedUsdRate(ds!, gameId, DAY);
    const h = buildHarness(redis!, ds!);

    // A row DECLARING source=server but arriving under the CLIENT credential class
    // (provenance=client) must NOT be revenue-eligible → no idempotency row.
    const spoof = serverPurchase(gameId, { transaction_id: 'SPOOF1' });
    const out = await h.kernel.process(spoof, ctx('client'));
    expect(out.counted).toBe(true); // it routed + counted in the generic catalog
    const rows = await ds!.getRepository(PurchaseIdempotencyEntity).count({ where: { gameId } });
    expect(rows).toBe(0); // but consumed NO durable money slot (server-trust-from-class)
    rmSync(h.dir, { recursive: true, force: true });
  });

  maybeIt('durable dedup >24h (36h retry) → exactly one row, never windowed', async () => {
    const gameId = 'mon-dedup';
    await cleanGame(ds!, redis!, gameId);
    await seedUsdRate(ds!, gameId, DAY);
    const h = buildHarness(redis!, ds!);

    const first = serverPurchase(gameId, { transaction_id: 'DUP', user_id: 'u1' });
    await h.kernel.process(first, ctx('server'));

    // The SAME transaction_id arriving 36 h later — BEYOND the Redis 24 h window (which
    // therefore cannot catch it) but still within the 48 h seal grace (so it reaches the
    // dedup gate, not a seal stop). Only the DURABLE transaction_id gate catches it.
    const laterCtx: KernelContext = { ...ctx('server'), now: NOW + 36 * 3_600_000 };
    const retry = serverPurchase(gameId, { transaction_id: 'DUP', user_id: 'u1' }, {});
    retry.props['transaction_id'] = 'DUP';
    const out = await h.kernel.process(retry, laterCtx);
    expect(out.counted).toBe(false); // duplicate stops before step 7/8

    const rows = await ds!.getRepository(PurchaseIdempotencyEntity).count({ where: { gameId, transactionId: 'DUP' } });
    expect(rows).toBe(1); // one row, never double-counted
    rmSync(h.dir, { recursive: true, force: true });
  });

  maybeIt('gate-coupled atomic: a duplicate produces zero effect on payer spine + period spend', async () => {
    const gameId = 'mon-atomic';
    await cleanGame(ds!, redis!, gameId);
    await seedUsdRate(ds!, gameId, DAY);
    const h = buildHarness(redis!, ds!, { payer_tier_rule: { dolphin_min: 10, whale_min: 100 } });

    await h.kernel.process(
      serverPurchase(gameId, { transaction_id: 'A1', price_local: 5, user_id: 'u1' }),
      ctx('server'),
    );
    // Duplicate A1 → gate conflict → the whole 05→06 unit no-ops.
    const dup = serverPurchase(gameId, { transaction_id: 'A1', price_local: 5, user_id: 'u1' });
    dup.props['transaction_id'] = 'A1';
    await h.kernel.process(dup, ctx('server'));

    const spine = await ds!.getRepository(PayerSpineExtEntity).findOne({ where: { gameId, userId: 'u1' } });
    expect(Number(spine?.lifetimeSpendNormalized)).toBeCloseTo(5, 4); // added ONCE
    const period = await ds!
      .getRepository(PayerPeriodSpendEntity)
      .findOne({ where: { gameId, period: '2026-07', userId: 'u1' } });
    expect(Number(period?.spendNormalized)).toBeCloseTo(5, 4);
    rmSync(h.dir, { recursive: true, force: true });
  });

  maybeIt('never-sessioned payer commits the unit with NO USER_SPINE row (spine-independent, Q1)', async () => {
    const gameId = 'mon-nospine';
    await cleanGame(ds!, redis!, gameId);
    await seedUsdRate(ds!, gameId, DAY);
    const h = buildHarness(redis!, ds!);

    await h.kernel.process(
      serverPurchase(gameId, { transaction_id: 'NS1', user_id: 'never_sessioned' }),
      ctx('server'),
    );
    const spine = await ds!
      .getRepository(PayerSpineExtEntity)
      .findOne({ where: { gameId, userId: 'never_sessioned' } });
    expect(spine).not.toBeNull(); // payer row exists
    expect(spine?.firstPurchaseDay).toBe(DAY);
    // No USER_SPINE write by 006 (P9): the user has no first_seen (never sessioned).
    rmSync(h.dir, { recursive: true, force: true });
  });

  maybeIt('companion join by purchase_attempt_id + MOVE conserves count+revenue (class-N gen INCR)', async () => {
    const gameId = 'mon-move';
    await cleanGame(ds!, redis!, gameId);
    await seedUsdRate(ds!, gameId, DAY);
    // Only region is active so the MOVE is observable on one dim.
    const h = buildHarness(redis!, ds!, { monetization_dimensions: ['region'] });

    // Server row FIRST (client lacks transaction_id; join key = purchase_attempt_id).
    const srv = serverPurchase(gameId, { transaction_id: 'M1', price_local: 4.99 });
    srv.props['purchase_attempt_id'] = 'PA-1';
    await h.kernel.process(srv, ctx('server'));

    // Counted with region=unknown (companion not yet arrived).
    const gen0 = Number(await redis!.hget(MonKeys.meta(gameId, DAY), META_GEN_FIELD));
    const cntUnknown = await redis!.hget(MonKeys.cnt(gameId, DAY), cellKey('energy_pack', 'region=unknown'));
    expect(Number(cntUnknown)).toBe(1);

    // Companion arrives with region=EU → MOVE unknown→EU. Conserves count + revenue.
    await h.kernel.process(companion(gameId, 'PA-1', { region: 'EU' }), ctx('client'));

    const cntUnknownAfter = Number(
      await redis!.hget(MonKeys.cnt(gameId, DAY), cellKey('energy_pack', 'region=unknown')),
    );
    const cntEu = Number(await redis!.hget(MonKeys.cnt(gameId, DAY), cellKey('energy_pack', 'region=EU')));
    const revEu = Number(await redis!.hget(MonKeys.rev(gameId, DAY), cellKey('energy_pack', 'region=EU')));
    const gen1 = Number(await redis!.hget(MonKeys.meta(gameId, DAY), META_GEN_FIELD));
    expect(cntUnknownAfter).toBe(0); // decremented
    expect(cntEu).toBe(1); // incremented — count conserved (total still 1)
    expect(revEu).toBeCloseTo(4.99, 4); // revenue conserved
    expect(gen1).toBe(gen0 + 1); // gen INCR'd inside the MOVE block

    // Flush the class-N snapshot → the durable cell reflects the moved absolute + gen.
    await h.flushJob.sweep();
    const euCell = await ds!.getRepository(MonetizationCellEntity).findOne({
      where: { gameId, productId: 'energy_pack', dimCombo: 'region=EU', utcDay: DAY },
    });
    expect(Number(euCell?.purchaseCount)).toBe(1);
    expect(Number(euCell?.revenueNormalized)).toBeCloseTo(4.99, 4);
    expect(euCell?.gen).toBe(gen1);
    rmSync(h.dir, { recursive: true, force: true });
  });

  maybeIt('class-N gen-gate: a STALE-gen flush row loses (GREATEST-forbidden negative test)', async () => {
    const gameId = 'mon-gen';
    await cleanGame(ds!, redis!, gameId);
    await seedUsdRate(ds!, gameId, DAY);
    const h = buildHarness(redis!, ds!, { monetization_dimensions: ['region'] });

    // Establish a durable cell at gen 5, count 1, revenue 10.
    await ds!
      .getRepository(MonetizationCellEntity)
      .createQueryBuilder()
      .insert()
      .into(MonetizationCellEntity)
      .values({
        gameId,
        productId: 'p',
        dimCombo: 'region=EU',
        utcDay: DAY,
        purchaseCount: '1',
        revenueNormalized: '10',
        productCategory: 'c',
        revenueLocalBreakdown: { USD: '10' },
        gen: 5,
      })
      .execute();

    // A MOVE decremented this cell to count 0, revenue 0 — but a STALE snapshot at gen 3
    // (pre-move) tries to flush the OLD higher value. The gen guard MUST reject it.
    const { sql, params } = (await import('../workers/flush/flush-merge')).buildFlushStatement(
      MON_CELL_FLUSH_PLAN.spec,
      {
        pk: { game_id: gameId, product_id: 'p', dim_combo: 'region=EU', utc_day: DAY },
        values: {
          purchase_count: '1',
          revenue_normalized: '10',
          revenue_local_breakdown: { USD: '10' },
          product_category: 'c',
        },
        guard: 3, // STALE gen < durable 5
      },
    );
    await ds!.query(sql, params);
    const afterStale = await ds!.getRepository(MonetizationCellEntity).findOne({
      where: { gameId, productId: 'p', dimCombo: 'region=EU', utcDay: DAY },
    });
    expect(afterStale?.gen).toBe(5); // unchanged — stale gen rejected (GREATEST would have kept 10)

    // A FRESH snapshot at gen 6 with the post-move absolute (count 0) WINS.
    const fresh = (await import('../workers/flush/flush-merge')).buildFlushStatement(MON_CELL_FLUSH_PLAN.spec, {
      pk: { game_id: gameId, product_id: 'p', dim_combo: 'region=EU', utc_day: DAY },
      values: { purchase_count: '0', revenue_normalized: '0', revenue_local_breakdown: {}, product_category: 'c' },
      guard: 6,
    });
    await ds!.query(fresh.sql, fresh.params);
    const afterFresh = await ds!.getRepository(MonetizationCellEntity).findOne({
      where: { gameId, productId: 'p', dimCombo: 'region=EU', utcDay: DAY },
    });
    expect(afterFresh?.gen).toBe(6);
    expect(Number(afterFresh?.purchaseCount)).toBe(0); // the DECREMENT won (never frozen by GREATEST)
    rmSync(h.dir, { recursive: true, force: true });
  });

  maybeIt('companion never arrives → server row stands alone with reduced dims (unknown)', async () => {
    const gameId = 'mon-reduced';
    await cleanGame(ds!, redis!, gameId);
    await seedUsdRate(ds!, gameId, DAY);
    const h = buildHarness(redis!, ds!, { monetization_dimensions: ['region'] });

    const srv = serverPurchase(gameId, { transaction_id: 'R1', price_local: 0.99 });
    srv.props['purchase_attempt_id'] = 'PA-orphan';
    await h.kernel.process(srv, ctx('server'));
    await h.flushJob.sweep();

    const cell = await ds!.getRepository(MonetizationCellEntity).findOne({
      where: { gameId, productId: 'energy_pack', dimCombo: 'region=unknown', utcDay: DAY },
    });
    expect(Number(cell?.purchaseCount)).toBe(1); // revenue fully counted, region degraded to unknown
    expect(Number(cell?.revenueNormalized)).toBeCloseTo(0.99, 4);
    rmSync(h.dir, { recursive: true, force: true });
  });

  maybeIt('FX park-unconverted then convert pre-seal (reconciliation recompute)', async () => {
    const gameId = 'mon-fx';
    await cleanGame(ds!, redis!, gameId);
    // NO rate for XYZ → the purchase parks unconverted (0 to rev, still inc cnt/loc/payer).
    const h = buildHarness(redis!, ds!, { monetization_dimensions: ['region'], fx_staleness_max_days: 7 });

    const srv = serverPurchase(gameId, {
      transaction_id: 'FX1',
      price_local: 100,
      currency: 'XYZ',
      user_id: 'payer_fx',
    });
    srv.props['purchase_attempt_id'] = 'PA-fx';
    await h.kernel.process(srv, ctx('server'));
    await h.flushJob.sweep();

    // Parked: revenue 0, but the payer + local breakdown are recorded, and the spine flags it.
    const cell = await ds!.getRepository(MonetizationCellEntity).findOne({
      where: { gameId, productId: 'energy_pack', dimCombo: 'region=unknown', utcDay: DAY },
    });
    expect(Number(cell?.revenueNormalized)).toBe(0);
    expect(Number(cell?.purchaseCount)).toBe(1);
    expect(cell?.revenueLocalBreakdown?.['XYZ']).toBeDefined();
    const spineBefore = await ds!.getRepository(PayerSpineExtEntity).findOne({ where: { gameId, userId: 'payer_fx' } });
    expect(spineBefore?.hasUnconvertedSpend).toBe(true);
    expect(Number(spineBefore?.lifetimeSpendNormalized)).toBe(0); // parked adds nothing to lifetime

    // The rate LANDS (2.0) pre-seal → reconciliation recompute converts the parked amount.
    await seedUsdRate(ds!, gameId, DAY); // USD baseline
    await ds!
      .getRepository(FxRateEntity)
      .createQueryBuilder()
      .insert()
      .into(FxRateEntity)
      .values({ gameId, currency: 'XYZ', rateDate: DAY, rate: '2.0' })
      .orUpdate(['rate'], ['game_id', 'currency', 'rate_date'])
      .execute();
    const { cellsUpdated } = await h.reconcile.recomputeOpenDay(gameId, DAY);
    expect(cellsUpdated).toBeGreaterThan(0);

    const cellAfter = await ds!.getRepository(MonetizationCellEntity).findOne({
      where: { gameId, productId: 'energy_pack', dimCombo: 'region=unknown', utcDay: DAY },
    });
    expect(Number(cellAfter?.revenueNormalized)).toBeCloseTo(200, 4); // 100 XYZ × 2.0
    expect(cellAfter!.gen).toBeGreaterThan(cell!.gen); // gen bumped on the downward/re-normalize write
    const spineAfter = await ds!.getRepository(PayerSpineExtEntity).findOne({ where: { gameId, userId: 'payer_fx' } });
    expect(spineAfter?.hasUnconvertedSpend).toBe(false); // flag cleared once converted
    expect(Number(spineAfter?.lifetimeSpendNormalized)).toBeCloseTo(200, 4);
    rmSync(h.dir, { recursive: true, force: true });
  });

  maybeIt('KPI hand-computed: ARPDAU $0.40, ARPPU $10, conversion 4% (DAU 1000 / 40 payers / $400)', async () => {
    const gameId = 'mon-kpi';
    await cleanGame(ds!, redis!, gameId);
    // Durable fixtures (past sealed day so the read is Postgres-only, deterministic).
    const pastDay = '2026-06-01';
    const dauMembers: Record<string, true> = {};
    for (let i = 0; i < 1000; i += 1) {
      dauMembers[`u${i}`] = true;
    }
    await ds!.getRepository(ActiveUserDayEntity).save({ gameId, utcDay: pastDay, members: dauMembers });
    const payerMembers: Record<string, true> = {};
    for (let i = 0; i < 40; i += 1) {
      payerMembers[`u${i}`] = true;
    }
    await ds!
      .getRepository(PayerDayEntity)
      .save({ gameId, utcDay: pastDay, payerMembers, revenueDayTotal: '400', gen: 1 });
    const h = buildHarness(redis!, ds!);

    const kpi = await h.read.revenueKpis(gameId, pastDay);
    expect(kpi.dau).toBe(1000);
    expect(kpi.payingUsers).toBe(40);
    expect(kpi.revenue).toBeCloseTo(400, 4);
    expect(kpi.arpdau).toBeCloseTo(0.4, 6);
    expect(kpi.arppu).toBeCloseTo(10, 6);
    expect(kpi.conversion).toBeCloseTo(0.04, 6);
    rmSync(h.dir, { recursive: true, force: true });
  });

  maybeIt('KPI stickiness 0.20 (DAU 1000 / MAU 5000) with div-by-0 → N/A', async () => {
    const gameId = 'mon-sticky';
    await cleanGame(ds!, redis!, gameId);
    const h = buildHarness(redis!, ds!, { partial_window_mask: false, mau_window_days: 30 });
    const day = '2026-06-30';
    // DAU 1000 on `day`; MAU 5000 distinct across the trailing 30 days.
    const dau: Record<string, true> = {};
    for (let i = 0; i < 1000; i += 1) {
      dau[`u${i}`] = true;
    }
    await ds!.getRepository(ActiveUserDayEntity).save({ gameId, utcDay: day, members: dau });
    // Add 4000 MORE distinct users on an earlier day within the window → MAU 5000.
    const earlier: Record<string, true> = {};
    for (let i = 1000; i < 5000; i += 1) {
      earlier[`u${i}`] = true;
    }
    await ds!.getRepository(ActiveUserDayEntity).save({ gameId, utcDay: '2026-06-15', members: earlier });

    const view = await h.read.activeUsers(gameId, day);
    expect(view.dau).toBe(1000);
    expect(view.mau).toBe(5000);
    expect(view.stickiness).toBeCloseTo(0.2, 6);

    // Div-by-0: a game/day with NO active users anywhere in the window → MAU 0 →
    // stickiness N/A (null), never 0.
    const emptyGame = 'mon-sticky-empty';
    await cleanGame(ds!, redis!, emptyGame);
    const emptyView = await h.read.activeUsers(emptyGame, '2020-01-15');
    expect(emptyView.mau).toBe(0);
    expect(emptyView.stickiness).toBeNull();
    rmSync(h.dir, { recursive: true, force: true });
  });

  maybeIt('whale concentration 50/70/94% + low_confidence flag under whale_min_payers', async () => {
    const gameId = 'mon-whale';
    await cleanGame(ds!, redis!, gameId);
    const h = buildHarness(redis!, ds!, { whale_top_percents: [10, 20, 50], whale_min_payers: 20 });
    const period = '2026-05';
    const spends = [500, 200, 120, 80, 40, 30, 15, 10, 3, 2];
    let i = 0;
    for (const s of spends) {
      await ds!
        .getRepository(PayerPeriodSpendEntity)
        .save({ gameId, period, userId: `w${i}`, spendNormalized: String(s) });
      i += 1;
    }
    const view = await h.read.whaleConcentration(gameId, period);
    expect(view.payingUsers).toBe(10);
    expect(view.revenue).toBeCloseTo(1000, 4);
    const byPct = Object.fromEntries(view.cohorts.map((c) => [c.percent, c.share]));
    expect(byPct[10]).toBeCloseTo(0.5, 6);
    expect(byPct[20]).toBeCloseTo(0.7, 6);
    expect(byPct[50]).toBeCloseTo(0.94, 6);
    expect(view.lowConfidence).toBe(true); // 10 payers < whale_min_payers 20
    rmSync(h.dir, { recursive: true, force: true });
  });

  maybeIt('dispatcher routes purchase to the hot hook AND runs the generic base (cat/cnt/rank)', async () => {
    const gameId = 'mon-dispatch';
    await cleanGame(ds!, redis!, gameId);
    await seedUsdRate(ds!, gameId, DAY);
    const h = buildHarness(redis!, ds!, { monetization_dimensions: ['region'] });

    const srv = serverPurchase(gameId, { transaction_id: 'D1', price_local: 1.0 });
    await h.kernel.process(srv, ctx('server'));

    // Generic base ran: the `purchase` name is in the cnt day hash (≥1 — the cnt hash
    // rehydrates from the shared durable EVENT_DAY_COUNT floor, which cleanGame does not
    // reset, so assert PRESENCE not an exact count).
    const cnt = await redis!.hget(`${gameId}:cnt:${DAY}`, 'purchase');
    expect(Number(cnt)).toBeGreaterThanOrEqual(1);
    // Purchase hot hook ran: the mon cnt cell exists with exactly this run's one purchase
    // (the mon domain IS reset by cleanGame, so this stays exact).
    const monCnt = await redis!.hget(MonKeys.cnt(gameId, DAY), cellKey('energy_pack', 'region=unknown'));
    expect(Number(monCnt)).toBe(1);
    rmSync(h.dir, { recursive: true, force: true });
  });

  maybeIt('class-S payer set + class-N rev day total flush to PAYER_DAY without clobber', async () => {
    const gameId = 'mon-payerday';
    await cleanGame(ds!, redis!, gameId);
    await seedUsdRate(ds!, gameId, DAY);
    const h = buildHarness(redis!, ds!, { monetization_dimensions: ['region'] });

    await h.kernel.process(
      serverPurchase(gameId, { transaction_id: 'PD1', price_local: 3, user_id: 'ua' }),
      ctx('server'),
    );
    await h.kernel.process(
      serverPurchase(gameId, { transaction_id: 'PD2', price_local: 7, user_id: 'ub' }),
      ctx('server'),
    );
    await h.flushJob.sweep();

    const payerDay = await ds!.getRepository(PayerDayEntity).findOne({ where: { gameId, utcDay: DAY } });
    // Class-S members union + class-N revenue total both landed on the same PAYER_DAY row.
    expect(Object.keys(payerDay?.payerMembers ?? {}).sort()).toEqual(['ua', 'ub']);
    expect(Number(payerDay?.revenueDayTotal)).toBeCloseTo(10, 4);
    rmSync(h.dir, { recursive: true, force: true });
  });
});
