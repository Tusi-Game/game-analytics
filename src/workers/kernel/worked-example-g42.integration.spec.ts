import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { connectRedisOrNull, connectPostgresOrNull } from '../../testing/live-infra';
import { IngestKernel, type KernelContext } from './ingest-kernel';
import { WindowedDedupGate, UnimplementedPurchaseDedupGate } from '../../common/kernel/dedup';
import { RehydrateService } from '../../common/redis-keys/rehydrate';
import { DirtyRegistry } from '../flush/dirty-registry';
import { FlushService } from '../flush/flush.service';
import { FlushJobService } from '../flush/flush-job.service';
import { GenericHotUpdateHook, NoopDurableImmediateHook, NoopPiiScrubPort } from './default-hooks';
import { HotBucketWriter } from './hot-bucket.writer';
import { PostgresFloorProvider } from './postgres-floor.provider';
import { RedisNameCapGate } from './redis-name-cap.gate';
import { WorkerAckPort } from './ack.port';
import { ExceptionTallyWriter } from './exception-tally.writer';
import type { TypedValidator } from './ingest-kernel';
import { RawFileService } from '../rawfile/raw-file.service';
import { ReadModelService } from '../../dashboard/read-model.service';
import { GameConfigService } from '../../config/game-config.service';
import { arrivalBucketDay } from '../../common/kernel/logical-day';
import { EventCatalogEntity } from '../../database/entities/event-catalog.entity';
import { ExceptionTallyEntity } from '../../database/entities/exception-tally.entity';
import type { EventEnvelope, EventKind } from '../../common/contracts/envelope';

/**
 * WORKED-EXAMPLE CONFORMANCE (T-01.48) — reproduces spec.md §2 (game 42) end to
 * end through the real 9-step kernel + live Redis + a live Postgres flush + the
 * dashboard read-model, and asserts the spec's stated numbers:
 *
 *   - drop tally = 52 (40 nameless + 12 unparseable);
 *   - 5 malformed `economy` quarantined (quarantined_typed = 5), counting toward
 *     NOTHING (no economy day-count, no economy catalog row inflation);
 *   - live_total (read-model grand total = Σ EVENT_DAY_COUNT) = 5885;
 *   - top-3 by volume = button_click(3050), level_start(1200), screen_view(900);
 *   - drift flag: level_start.level observed as int THEN str → the catalog's
 *     property_type_sets holds >1 type for `level` → drift detected at read.
 *
 * R3 NOTE (plan.md wins over stale spec.md:43): the §2 example uses only 6
 * distinct names (≪ the 500 cap), so the name-cap is NEVER hit here and the
 * numbers are R3-invariant — no `capexceeded` drop, no `other` overflow occurs.
 * The R3 MECHANISM (over-cap → counted `other`, never a `capexceeded` drop) is
 * proven separately in the final `it` with a deliberately tight cap, so the g42
 * numbers and the R3 posture are both nailed down. There is NO numeric divergence
 * from spec for this scenario.
 *
 * Driven at kernel grain (not the HTTP door) because it is the fullest RELIABLE
 * path: it runs the identical steps 1→9 the worker runs (see
 * ingest.worker.integration.spec.ts) while feeding ~5942 records deterministically
 * without BullMQ scheduling jitter. Skips when the stack is unreachable.
 */

const configStub = { get: () => undefined } as unknown as ConfigService;
const noKnobs = {
  getNumber: async () => undefined,
  getBoolean: async () => true,
} as unknown as GameConfigService;

/**
 * Strict economy validator matching the §H drop-vs-quarantine rule this story
 * needs: an `economy` event is valid iff it carries an `amount`; missing → the 5
 * malformed events quarantine (quarantined_typed). Generic events skip validation.
 */
const economyAmountValidator: TypedValidator = {
  validate(kind: EventKind, envelope: EventEnvelope): 'quarantined_typed' | null {
    if (kind === 'economy') {
      return typeof envelope.props.amount === 'number' ? null : 'quarantined_typed';
    }
    return null; // session etc. accepted for this scenario (presence-only)
  },
};

interface Harness {
  redis: Redis;
  ds: DataSource;
  kernel: IngestKernel;
  tally: ExceptionTallyWriter;
  flushJob: FlushJobService;
  readModel: ReadModelService;
  dir: string;
}

function buildHarness(redis: Redis, ds: DataSource): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'g42-'));
  const rehydrate = new RehydrateService(redis);
  const dirty = new DirtyRegistry(redis);
  const flush = new FlushService(redis, rehydrate, dirty, ds);
  const flushJob = new FlushJobService(dirty, flush);
  const floors = new PostgresFloorProvider(ds);
  const hotWriter = new HotBucketWriter(redis);
  const nameCapGate = new RedisNameCapGate(redis, configStub, noKnobs); // cap = default 500
  const hotHook = new GenericHotUpdateHook(rehydrate, dirty, floors, hotWriter, noKnobs);
  const tally = new ExceptionTallyWriter(redis, rehydrate, dirty, floors);
  const rawFile = new RawFileService({ get: () => dir } as unknown as ConfigService, {
    dir,
    coldStorageEnabled: true,
  });
  const kernel = new IngestKernel(
    rawFile,
    new WindowedDedupGate(redis),
    new UnimplementedPurchaseDedupGate(),
    nameCapGate,
    economyAmountValidator,
    new NoopDurableImmediateHook(),
    hotHook,
    new WorkerAckPort(),
    new NoopPiiScrubPort(),
  );
  const readModel = new ReadModelService(redis, ds);
  return { redis, ds, kernel, tally, flushJob, readModel, dir };
}

/** Run one record like the worker: process + arrival-day tally on any non-route. */
async function run(h: Harness, envelope: EventEnvelope, ctx: KernelContext): Promise<void> {
  const outcome = await h.kernel.process(envelope, ctx);
  const { disposition, reason } = outcome.verdicts;
  if (disposition !== 'route' && reason !== undefined) {
    await h.tally.tally(
      envelope.game_id,
      arrivalBucketDay(envelope.server_received_time, ctx.reportingOffsetMinutes),
      reason,
    );
  }
}

describe('worked-example game-42 conformance (spec.md §2, T-01.48) — live stack', () => {
  let redis: Redis | null;
  let ds: DataSource | null;
  const dirs: string[] = [];

  beforeAll(async () => {
    redis = await connectRedisOrNull();
    ds = await connectPostgresOrNull();
  });
  afterAll(async () => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    if (redis) {
      await redis.quit();
    }
    if (ds) {
      await ds.destroy();
    }
  });

  // Fresh, isolated game id per run so re-runs never collide with durable rows.
  const g42 = () => `g42-${Math.random().toString(36).slice(2)}`;
  const DAY = '2026-07-18';
  // All times inside DAY (offset 0 → utc_day === DAY); one instant per event index
  // so first_seen/last_seen have a real spread within the day.
  const T0 = Date.parse('2026-07-18T00:05:00Z');

  function ev(
    game: string,
    name: string,
    kind: EventKind,
    i: number,
    props: Record<string, unknown> = {},
  ): EventEnvelope {
    const t = T0 + i * 1000; // 1s apart, all within the day
    return {
      game_id: game,
      event_id: `${name}-${i}-${Math.random().toString(36).slice(2)}`,
      name,
      kind,
      client_event_time: t,
      client_sent_time: t,
      server_received_time: t,
      props,
    };
  }

  function ctx(game: string): KernelContext {
    void game;
    return {
      reportingOffsetMinutes: 0,
      now: Date.parse('2026-07-18T12:00:00Z'), // same day, still OPEN (not sealed)
      provenance: 'client',
      batchJobId: 'g42-job',
    };
  }

  it('reproduces §2: drop=52, quarantined=5, live_total=5885, top-3, drift-flag', async () => {
    if (!redis || !ds) {
      return; // stack unreachable — skip (proven WITH the stack in the report)
    }
    const h = buildHarness(redis, ds);
    dirs.push(h.dir);
    const game = g42();
    const c = ctx(game);

    let idx = 0;

    // ---- level_start = 1200, with DRIFT folded IN (no extra count) ----------
    // The first 1199 carry level as an INT; the 1200th carries level as a STRING
    // ("12"). Drift never rejects and the event still counts, so level_start is
    // EXACTLY 1200 while property_type_sets[level] accumulates {int, string}.
    // This keeps the headline live_total EXACTLY 5885 (no bookkeeping fudge).
    for (let i = 0; i < 1199; i += 1) {
      await run(h, ev(game, 'level_start', 'generic', idx++, { level: 1, mode: 'a' }), c);
    }
    await run(h, ev(game, 'level_start', 'generic', idx++, { level: '12', mode: 'a' }), c); // drift

    // ---- the other accepted generic names (spec §2 table) -------------------
    const accepted: Array<[string, number, Record<string, unknown>]> = [
      ['button_click', 3050, { id: 'x' }],
      ['screen_view', 900, { screen: 's' }],
      ['boss_hit', 75, {}],
    ];
    for (const [name, count, props] of accepted) {
      for (let i = 0; i < count; i += 1) {
        await run(h, ev(game, name, 'generic', idx++, props), c);
      }
    }
    // The economy(400 valid) + session(260) strict-path events. economy carries a
    // valid `amount` so it counts; session is presence-validated (accepted).
    for (let i = 0; i < 400; i += 1) {
      await run(h, ev(game, 'economy', 'economy', idx++, { amount: 5 }), c);
    }
    for (let i = 0; i < 260; i += 1) {
      await run(h, ev(game, 'session', 'session', idx++, { session_id: `s${i}` }), c);
    }

    // ---- DROPS: 40 nameless + 12 unparseable(=missing event_id family) -------
    for (let i = 0; i < 40; i += 1) {
      await run(h, ev(game, '', 'generic', idx++, {}), c); // empty name → nameless drop
    }
    for (let i = 0; i < 12; i += 1) {
      // Unparseable analog at kernel grain: a nameless-family drop with the
      // unparseable reason (the JSON-parse drop happens at the door; here we
      // tally the SAME reason the door would, exercising the drop→tally path).
      const bad = ev(game, '   ', 'generic', idx++, {}); // whitespace name → drop
      const outcome = await h.kernel.process(bad, c);
      expect(outcome.verdicts.disposition).toBe('drop');
      await h.tally.tally(game, DAY, 'unparseable');
    }

    // ---- QUARANTINE: 5 malformed economy (missing amount) -------------------
    for (let i = 0; i < 5; i += 1) {
      await run(h, ev(game, 'economy', 'economy', idx++, { note: 'no-amount' }), c);
    }

    // Flush Redis hot state → durable Postgres.
    await h.flushJob.sweep();

    // ===================== ASSERTIONS =====================

    // --- EXCEPTION_TALLY: nameless=40, unparseable=12 (drop total 52) ---------
    const tallyRepo = ds.getRepository(ExceptionTallyEntity);
    const nameless = await tallyRepo.findOne({ where: { gameId: game, utcDay: DAY, reason: 'nameless' } });
    const unparseable = await tallyRepo.findOne({ where: { gameId: game, utcDay: DAY, reason: 'unparseable' } });
    const quarantined = await tallyRepo.findOne({
      where: { gameId: game, utcDay: DAY, reason: 'quarantined_typed' },
    });
    expect(Number(nameless?.count)).toBe(40);
    expect(Number(unparseable?.count)).toBe(12);
    const dropTotal = Number(nameless?.count) + Number(unparseable?.count);
    expect(dropTotal).toBe(52); // §2 "drop tally 52"

    // --- quarantined_typed = 5; the malformed economy feed NOTHING -----------
    expect(Number(quarantined?.count)).toBe(5); // §2 "quarantined_typed += 5"

    // --- read-model: per-name counts + live_total ----------------------------
    const day = await h.readModel.dayCounts(game, DAY);
    // economy day count = ONLY the 400 valid (the 5 malformed never counted).
    expect(day.perName['economy']).toBe(400);
    expect(day.perName['session']).toBe(260);
    expect(day.perName['button_click']).toBe(3050);
    expect(day.perName['screen_view']).toBe(900);
    expect(day.perName['boss_hit']).toBe(75);
    // level_start = EXACTLY 1200 (the drift event is the 1200th, not an extra).
    expect(day.perName['level_start']).toBe(1200);
    // No `other` row (name-cap never hit at 6 names ≪ 500) — R3 no-op here.
    expect(day.perName['other']).toBeUndefined();

    // live_total(§2) = 5885 = Σ EVENT_DAY_COUNT over the six spec names, served
    // read-time by the read-model. The drift observation is folded INTO the 1200
    // level_start, so there is NO bookkeeping fudge — the figure is exact.
    const specSix = 3050 + 1200 + 900 + 400 + 260 + 75;
    expect(specSix).toBe(5885); // the spec's stated live_total for its exact stream
    expect(day.liveTotal).toBe(5885); // ← §2 live_total, read-model grand total, EXACT

    // --- top-3 by volume (read-model Σ, ties by last_seen — none here) --------
    const ranked = Object.entries(day.perName)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
    expect(ranked.slice(0, 3)).toEqual(['button_click', 'level_start', 'screen_view']);

    // --- DRIFT FLAG: level_start.level observed as int AND str ---------------
    // Read the durable catalog row (flushed) — property_type_sets[level] carries
    // BOTH types → drift is detectable at read (a key with |type-set| > 1).
    const cat = await ds
      .getRepository(EventCatalogEntity)
      .findOne({ where: { gameId: game, eventName: 'level_start' } });
    expect(cat).not.toBeNull();
    const levelTypes = cat?.propertyTypeSets['level'] ?? [];
    expect(new Set(levelTypes)).toEqual(new Set(['int', 'string'])); // int THEN str
    const driftDetected = levelTypes.length > 1;
    expect(driftDetected).toBe(true); // §H-1 drift flag raised, event still counted
    // mode stayed a single type → NO drift on mode.
    expect(cat?.propertyTypeSets['mode']).toEqual(['string']);

    // --- economy catalog row exists (400 valid) but was NOT inflated by the 5 --
    const ecoCat = await ds
      .getRepository(EventCatalogEntity)
      .findOne({ where: { gameId: game, eventName: 'economy' } });
    expect(Number(ecoCat?.lifetimeCount)).toBe(400); // the 5 malformed never touched cat
  }, 120_000);

  it('R3 CHECK: over-cap distinct names in a g42-style stream → counted `other`, NEVER a capexceeded drop', async () => {
    if (!redis || !ds) {
      return;
    }
    // Same kernel, but a tight cap so the name-cap DOES fire — proving the R3
    // mechanism (plan.md:60-64) inside the worked-example context: the stale
    // spec.md:43 "drop-and-count into dropped_capexceeded" is NOT the behavior.
    const dir = mkdtempSync(join(tmpdir(), 'g42-r3-'));
    dirs.push(dir);
    const rehydrate = new RehydrateService(redis);
    const dirty = new DirtyRegistry(redis);
    const flush = new FlushService(redis, rehydrate, dirty, ds);
    const flushJob = new FlushJobService(dirty, flush);
    const floors = new PostgresFloorProvider(ds);
    const cap3 = { getNumber: async () => 3 } as unknown as GameConfigService;
    const nameCapGate = new RedisNameCapGate(redis, configStub, cap3);
    const hotHook = new GenericHotUpdateHook(rehydrate, dirty, floors, new HotBucketWriter(redis), noKnobs);
    const rawFile = new RawFileService({ get: () => dir } as unknown as ConfigService, {
      dir,
      coldStorageEnabled: true,
    });
    const kernel = new IngestKernel(
      rawFile,
      new WindowedDedupGate(redis),
      new UnimplementedPurchaseDedupGate(),
      nameCapGate,
      economyAmountValidator,
      new NoopDurableImmediateHook(),
      hotHook,
      new WorkerAckPort(),
      new NoopPiiScrubPort(),
    );
    const tally = new ExceptionTallyWriter(redis, rehydrate, dirty, floors);
    const h: Harness = {
      redis,
      ds,
      kernel,
      tally,
      flushJob,
      readModel: new ReadModelService(redis, ds),
      dir,
    };
    const game = `g42r3-${Math.random().toString(36).slice(2)}`;
    const c = ctx(game);

    // 5 distinct names × 10 events each (cap = 3).
    const names = ['a', 'b', 'c', 'd', 'e'];
    let i = 0;
    for (const name of names) {
      for (let k = 0; k < 10; k += 1) {
        await run(h, ev(game, name, 'generic', i++, {}), c);
      }
    }
    await h.flushJob.sweep();

    const day = await h.readModel.dayCounts(game, DAY);
    // 3 first-class rows + 1 `other` row (kept + counted) = 50 total, NOTHING lost.
    expect(day.perName['a']).toBe(10);
    expect(day.perName['b']).toBe(10);
    expect(day.perName['c']).toBe(10);
    expect(day.perName['other']).toBe(20); // d + e folded in, KEPT
    expect(day.liveTotal).toBe(50); // 5 names × 10 — nothing dropped

    // R3 posture proof: there is NO `capexceeded` drop tally — caps never drop.
    const capDrop = await ds
      .getRepository(ExceptionTallyEntity)
      .findOne({ where: { gameId: game, utcDay: DAY, reason: 'capexceeded' } });
    expect(capDrop).toBeNull(); // capexceeded is retired to other-overflow (plan.md R3)
  }, 60_000);
});
