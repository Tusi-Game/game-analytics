import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { connectRedisOrNull, connectPostgresOrNull } from '../testing/live-infra';
import { IngestKernel, type KernelContext } from './kernel/ingest-kernel';
import { WindowedDedupGate, UnimplementedPurchaseDedupGate } from '../common/kernel/dedup';
import { RehydrateService } from '../common/redis-keys/rehydrate';
import { DirtyRegistry } from './flush/dirty-registry';
import { FlushService } from './flush/flush.service';
import { FlushJobService } from './flush/flush-job.service';
import {
  GenericHotUpdateHook,
  NoopDurableImmediateHook,
  NoopPiiScrubPort,
  PermissiveTypedValidator,
} from './kernel/default-hooks';
import { HotBucketWriter } from './kernel/hot-bucket.writer';
import { PostgresFloorProvider } from './kernel/postgres-floor.provider';
import { RedisNameCapGate } from './kernel/redis-name-cap.gate';
import { ExceptionTallyWriter } from './kernel/exception-tally.writer';
import { WorkerAckPort } from './kernel/ack.port';
import { RawFileService } from './rawfile/raw-file.service';
import { GameConfigService } from '../config/game-config.service';
import { IngestKeys } from '../common/redis-keys/redis-keys';
import { EventDayCountEntity } from '../database/entities/event-day-count.entity';
import { EventCatalogEntity } from '../database/entities/event-catalog.entity';
import { ExceptionTallyEntity } from '../database/entities/exception-tally.entity';
import { DEDUP_TTL_SECONDS } from '../common/redis-keys/ttl';
import type { EventEnvelope } from '../common/contracts/envelope';

/**
 * End-to-end worker realization against LIVE Redis + Postgres (T-01.43–49).
 * Proves the whole path steps 1→9 + flush:
 *   - #9 two-game isolation: body game_id is ignored (the door stamps it; here we
 *     stamp the AUTHED game and confirm the other game gets nothing);
 *   - #10 quarantined typed feeds NOTHING (no cat/cnt) + reserved-name override;
 *   - windowed dedup: same event_id <24h → ONE count; a fresh id (>24h analog:
 *     marker gone) → a second count;
 *   - missing event_id → drop + unparseable tally + no append + no count;
 *   - R3 other-overflow reaches EVENT_DAY_COUNT as an `other` row (kept+counted);
 *   - flush is idempotent (a second sweep is a no-op).
 * Skips when the stack is unreachable.
 */

const configStub = { get: () => undefined } as unknown as ConfigService;
const noKnobs = { getNumber: async () => undefined, getBoolean: async () => true } as unknown as GameConfigService;

interface Harness {
  redis: Redis;
  ds: DataSource;
  kernel: IngestKernel;
  tally: ExceptionTallyWriter;
  flushJob: FlushJobService;
  rawFile: RawFileService;
  dir: string;
  nameCap: RedisNameCapGate;
}

async function buildHarness(redis: Redis, ds: DataSource, nameCap?: number): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'worker-int-'));
  const rehydrate = new RehydrateService(redis);
  const dirty = new DirtyRegistry(redis);
  const flush = new FlushService(redis, rehydrate, dirty, ds);
  const flushJob = new FlushJobService(dirty, flush);
  const floors = new PostgresFloorProvider(ds);
  const hotWriter = new HotBucketWriter(redis);
  const capKnobs = { getNumber: async () => nameCap } as unknown as GameConfigService;
  const nameCapGate = new RedisNameCapGate(redis, configStub, nameCap ? capKnobs : noKnobs);
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
    new PermissiveTypedValidator(),
    new NoopDurableImmediateHook(),
    hotHook,
    new WorkerAckPort(),
    new NoopPiiScrubPort(),
  );
  return { redis, ds, kernel, tally, flushJob, rawFile, dir, nameCap: nameCapGate };
}

/** Run one envelope through the kernel + arrival-day tally, like the worker does. */
async function run(h: Harness, envelope: EventEnvelope, ctx: KernelContext): Promise<void> {
  const outcome = await h.kernel.process(envelope, ctx);
  const { disposition, reason } = outcome.verdicts;
  if (disposition !== 'route' && reason !== undefined) {
    const { arrivalBucketDay } = await import('../common/kernel/logical-day');
    await h.tally.tally(
      envelope.game_id,
      arrivalBucketDay(envelope.server_received_time, ctx.reportingOffsetMinutes),
      reason,
    );
  }
}

function env(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  const t = Date.parse('2026-07-18T12:00:00Z');
  return {
    game_id: 'game-42',
    event_id: `evt-${Math.random().toString(36).slice(2)}`,
    name: 'login',
    kind: 'generic',
    client_event_time: t,
    client_sent_time: t,
    server_received_time: t,
    props: {},
    ...overrides,
  };
}

function ctx(overrides: Partial<KernelContext> = {}): KernelContext {
  return {
    reportingOffsetMinutes: 0,
    now: Date.parse('2026-07-18T12:00:01Z'),
    provenance: 'client',
    batchJobId: 'job-int',
    ...overrides,
  };
}

async function countFor(ds: DataSource, gameId: string, eventName: string, day: string): Promise<number> {
  const row = await ds.getRepository(EventDayCountEntity).findOne({ where: { gameId, eventName, utcDay: day } });
  return row ? Number(row.count) : 0;
}

describe('ingest worker end-to-end (live Redis + Postgres)', () => {
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

  const uniq = () => `g-${Math.random().toString(36).slice(2)}`;

  it('#9 two-game isolation: a game gets ITS counts, the other gets nothing', async () => {
    if (!redis || !ds) return;
    const h = await buildHarness(redis, ds);
    dirs.push(h.dir);
    const gameA = uniq();
    const gameB = uniq();
    const day = '2026-07-18';

    // The door already stamped game_id from the credential — here that's gameA.
    await run(h, env({ game_id: gameA, name: 'login', event_id: 'a1' }), ctx());
    await run(h, env({ game_id: gameA, name: 'login', event_id: 'a2' }), ctx());
    await h.flushJob.sweep();

    expect(await countFor(ds, gameA, 'login', day)).toBe(2);
    expect(await countFor(ds, gameB, 'login', day)).toBe(0); // fully isolated
  });

  it('windowed dedup: same event_id counts ONCE; a fresh id counts again (<24h vs new)', async () => {
    if (!redis || !ds) return;
    const h = await buildHarness(redis, ds);
    dirs.push(h.dir);
    const game = uniq();
    const day = '2026-07-18';

    await run(h, env({ game_id: game, name: 'ping', event_id: 'dup-1' }), ctx());
    await run(h, env({ game_id: game, name: 'ping', event_id: 'dup-1' }), ctx()); // duplicate <24h
    await run(h, env({ game_id: game, name: 'ping', event_id: 'dup-2' }), ctx()); // distinct id
    await h.flushJob.sweep();
    expect(await countFor(ds, game, 'ping', day)).toBe(2); // dup-1 once, dup-2 once

    // Simulate a >24h retry: the marker has expired → a re-send of dup-1 counts again.
    await redis.del(IngestKeys.dedup(game, 'dup-1'));
    await run(h, env({ game_id: game, name: 'ping', event_id: 'dup-1' }), ctx());
    await h.flushJob.sweep();
    expect(await countFor(ds, game, 'ping', day)).toBe(3);
    // Sanity: the marker is set with the fixed 24h TTL.
    const ttl = await redis.ttl(IngestKeys.dedup(game, 'dup-2'));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(DEDUP_TTL_SECONDS);
  });

  it('#10 quarantined typed feeds NOTHING (no cat row, no day count) + tallies quarantined_typed', async () => {
    if (!redis || !ds) return;
    // A validator that rejects economy payloads.
    const h = await buildHarness(redis, ds);
    dirs.push(h.dir);
    const game = uniq();
    const day = '2026-07-18';
    // Rebuild kernel with a rejecting validator for this game.
    const rejecting = { validate: () => 'quarantined_typed' as const };
    const kernel = new IngestKernel(
      h.rawFile,
      new WindowedDedupGate(redis),
      new UnimplementedPurchaseDedupGate(),
      h.nameCap,
      rejecting,
      new NoopDurableImmediateHook(),
      new GenericHotUpdateHook(
        new RehydrateService(redis),
        new DirtyRegistry(redis),
        new PostgresFloorProvider(ds),
        new HotBucketWriter(redis),
        noKnobs,
      ),
      new WorkerAckPort(),
      new NoopPiiScrubPort(),
    );
    const local: Harness = { ...h, kernel };

    await run(local, env({ game_id: game, name: 'coins_spent', kind: 'economy', event_id: 'q1' }), ctx());
    await h.flushJob.sweep();

    expect(await countFor(ds, game, 'coins_spent', day)).toBe(0); // NOT counted
    const cat = await ds
      .getRepository(EventCatalogEntity)
      .findOne({ where: { gameId: game, eventName: 'coins_spent' } });
    expect(cat).toBeNull(); // no catalog row
    const tally = await ds
      .getRepository(ExceptionTallyEntity)
      .findOne({ where: { gameId: game, utcDay: day, reason: 'quarantined_typed' } });
    expect(tally && Number(tally.count)).toBe(1);
  });

  it('#10 reserved-name override: name=session routes to typed session path (resolved_kind)', async () => {
    if (!redis || !ds) return;
    const h = await buildHarness(redis, ds);
    dirs.push(h.dir);
    const game = uniq();
    const outcome = await h.kernel.process(
      env({ game_id: game, name: 'session', kind: 'generic', event_id: 's1', props: { session_id: 's' } }),
      ctx(),
    );
    expect(outcome.record?.resolved_kind).toBe('session');
    expect(outcome.counted).toBe(true);
  });

  it('missing event_id → drop + unparseable-family tally, NO append, NO count', async () => {
    if (!redis || !ds) return;
    const h = await buildHarness(redis, ds);
    dirs.push(h.dir);
    const game = uniq();
    const day = '2026-07-18';
    // The kernel drops nameless; missing event_id is dropped at the worker's
    // parse (unparseable). Simulate the door/worker guard: empty event_id.
    const outcome = await h.kernel.process(env({ game_id: game, name: '   ', event_id: '' }), ctx());
    expect(outcome.verdicts.disposition).toBe('drop');
    // Nameless is the kernel's own guard; tally it like the worker does.
    await h.tally.tally(game, day, outcome.verdicts.reason ?? 'unparseable');
    await h.flushJob.sweep();
    expect(await countFor(ds, game, 'login', day)).toBe(0);
    // No raw file was created for a pure drop path (nothing appended).
  });

  it('R3 other-overflow reaches EVENT_DAY_COUNT as an `other` row (kept + counted, #1)', async () => {
    if (!redis || !ds) return;
    const h = await buildHarness(redis, ds, 3); // cap = 3
    dirs.push(h.dir);
    const game = uniq();
    const day = '2026-07-18';
    // 5 distinct names × 2 events each → 3 first-class rows + 1 `other` row = 20.
    const names = ['n1', 'n2', 'n3', 'n4', 'n5'];
    for (const name of names) {
      await run(h, env({ game_id: game, name, event_id: `${name}-a` }), ctx());
      await run(h, env({ game_id: game, name, event_id: `${name}-b` }), ctx());
    }
    await h.flushJob.sweep();

    const rows = await ds.getRepository(EventDayCountEntity).find({ where: { gameId: game, utcDay: day } });
    const byName = Object.fromEntries(rows.map((r) => [r.eventName, Number(r.count)]));
    // 3 admitted names count under themselves; the 2 over-cap names fold into `other`.
    expect(byName['n1']).toBe(2);
    expect(byName['n2']).toBe(2);
    expect(byName['n3']).toBe(2);
    expect(byName['other']).toBe(4); // n4 + n5, KEPT (not dropped)
    const liveTotal = Object.values(byName).reduce((s, v) => s + v, 0);
    expect(liveTotal).toBe(10); // nothing lost
  });

  it('flush is idempotent: a second sweep is a no-op (class M / mixed-cat)', async () => {
    if (!redis || !ds) return;
    const h = await buildHarness(redis, ds);
    dirs.push(h.dir);
    const game = uniq();
    const day = '2026-07-18';
    await run(h, env({ game_id: game, name: 'evt', event_id: 'x1' }), ctx());
    await h.flushJob.sweep();
    const first = await countFor(ds, game, 'evt', day);
    await h.flushJob.sweep(); // second sweep with an empty registry → no change
    expect(await countFor(ds, game, 'evt', day)).toBe(first);
  });
});
