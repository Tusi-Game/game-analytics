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
import {
  GenericHotUpdateHook,
  NoopDurableImmediateHook,
  NoopPiiScrubPort,
  PermissiveTypedValidator,
} from './default-hooks';
import { HotBucketWriter } from './hot-bucket.writer';
import { PostgresFloorProvider } from './postgres-floor.provider';
import { RedisNameCapGate } from './redis-name-cap.gate';
import { WorkerAckPort } from './ack.port';
import { RawFileService } from '../rawfile/raw-file.service';
import { GameConfigService } from '../../config/game-config.service';
import { IngestKeys } from '../../common/redis-keys/redis-keys';
import { EventCatalogEntity } from '../../database/entities/event-catalog.entity';
import type { EventEnvelope } from '../../common/contracts/envelope';

/**
 * DARK-SPOT #2 THROUGH THE FULL FLUSH — cat.first_seen = LEAST (min), across
 * SEPARATE flush sweeps and a rehydrate-from-Postgres-floor cycle.
 *
 * cat is day-less and NEVER seals, so a wrong-direction first_seen (GREATEST
 * instead of LEAST) can NEVER self-heal. The Redis hot-path LEAST merge is proven
 * in hot-path.integration.spec.ts and the SQL generator's LEAST clause in
 * flush-merge.spec.ts — but neither exercises the DURABLE end-to-end property:
 * events arriving in DESCENDING corrected-time order, flushed in two sweeps, must
 * leave the Postgres row's first_seen at the global MIN and last_seen at the MAX,
 * even after the second batch rehydrates from the durable floor. This is that
 * missing durable guard. Skips when the stack is unreachable.
 */

const configStub = { get: () => undefined } as unknown as ConfigService;
const noKnobs = {
  getNumber: async () => undefined,
  getBoolean: async () => true,
} as unknown as GameConfigService;

interface Harness {
  redis: Redis;
  ds: DataSource;
  kernel: IngestKernel;
  flushJob: FlushJobService;
  dir: string;
}

function buildHarness(redis: Redis, ds: DataSource): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'cat-least-'));
  const rehydrate = new RehydrateService(redis);
  const dirty = new DirtyRegistry(redis);
  const flush = new FlushService(redis, rehydrate, dirty, ds);
  const flushJob = new FlushJobService(dirty, flush);
  const floors = new PostgresFloorProvider(ds);
  const hotHook = new GenericHotUpdateHook(rehydrate, dirty, floors, new HotBucketWriter(redis), noKnobs);
  const rawFile = new RawFileService({ get: () => dir } as unknown as ConfigService, {
    dir,
    coldStorageEnabled: true,
  });
  const kernel = new IngestKernel(
    rawFile,
    new WindowedDedupGate(redis),
    new UnimplementedPurchaseDedupGate(),
    new RedisNameCapGate(redis, configStub, noKnobs),
    new PermissiveTypedValidator(),
    new NoopDurableImmediateHook(),
    hotHook,
    new WorkerAckPort(),
    new NoopPiiScrubPort(),
  );
  return { redis, ds, kernel, flushJob, dir };
}

describe('cat.first_seen = LEAST through the full Postgres flush (DARK-SPOT #2) — live stack', () => {
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

  const game = () => `catleast-${Math.random().toString(36).slice(2)}`;

  function ev(g: string, iso: string): EventEnvelope {
    const t = Date.parse(iso);
    return {
      game_id: g,
      event_id: `ls-${Math.random().toString(36).slice(2)}`,
      name: 'level_start',
      kind: 'generic',
      client_event_time: t,
      client_sent_time: t,
      server_received_time: t,
      props: {},
    };
  }

  function ctx(): KernelContext {
    return {
      reportingOffsetMinutes: 0,
      now: Date.parse('2026-07-18T23:00:00Z'), // same day, still open
      provenance: 'client',
      batchJobId: 'catleast-job',
    };
  }

  it('descending arrivals across TWO sweeps → durable first_seen = MIN, last_seen = MAX', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds);
    dirs.push(h.dir);
    const g = game();

    // ---- Sweep 1: the LATEST time arrives first --------------------------------
    // 10:00 then 12:00 → first_seen=10:00, last_seen=12:00 durable after flush.
    await h.kernel.process(ev(g, '2026-07-18T12:00:00Z'), ctx());
    await h.kernel.process(ev(g, '2026-07-18T10:00:00Z'), ctx());
    await h.flushJob.sweep();

    const afterFirst = await ds
      .getRepository(EventCatalogEntity)
      .findOne({ where: { gameId: g, eventName: 'level_start' } });
    expect(afterFirst?.firstSeen.toISOString()).toBe('2026-07-18T10:00:00.000Z');
    expect(afterFirst?.lastSeen.toISOString()).toBe('2026-07-18T12:00:00.000Z');
    expect(Number(afterFirst?.lifetimeCount)).toBe(2);

    // ---- Drop the hot cat hash so sweep 2 REHYDRATES from the durable floor ----
    // This is the load-bearing path: the floor seeds first_seen=10:00; an EARLIER
    // event (08:00) must still LOWER it to 08:00, and a LATER one must NOT raise it.
    await redis.del(IngestKeys.cat(g, 'level_start'));

    // ---- Sweep 2: an EARLIER time (08:00) + a LATER time (14:00) ---------------
    await h.kernel.process(ev(g, '2026-07-18T08:00:00Z'), ctx()); // earlier than the floor
    await h.kernel.process(ev(g, '2026-07-18T14:00:00Z'), ctx()); // later than the floor
    await h.flushJob.sweep();

    const afterSecond = await ds
      .getRepository(EventCatalogEntity)
      .findOne({ where: { gameId: g, eventName: 'level_start' } });
    // first_seen LOWERED to the global MIN (08:00) — LEAST across the rehydrate.
    expect(afterSecond?.firstSeen.toISOString()).toBe('2026-07-18T08:00:00.000Z');
    // last_seen RAISED to the global MAX (14:00) — GREATEST.
    expect(afterSecond?.lastSeen.toISOString()).toBe('2026-07-18T14:00:00.000Z');
    // count accumulated all four (rehydrate seeded the floor of 2, +2 more).
    expect(Number(afterSecond?.lifetimeCount)).toBe(4);
  }, 60_000);

  it('a retried flush is a NO-OP on cat (idempotent LEAST/GREATEST/UNION merge)', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds);
    dirs.push(h.dir);
    const g = game();
    await h.kernel.process(ev(g, '2026-07-18T09:00:00Z'), ctx());
    await h.flushJob.sweep();
    const first = await ds
      .getRepository(EventCatalogEntity)
      .findOne({ where: { gameId: g, eventName: 'level_start' } });
    // A second sweep with an empty dirty registry re-flushes nothing; even if the
    // same row re-flushed, LEAST/GREATEST of equal values is a no-op.
    await h.flushJob.sweep();
    const second = await ds
      .getRepository(EventCatalogEntity)
      .findOne({ where: { gameId: g, eventName: 'level_start' } });
    expect(second?.firstSeen.toISOString()).toBe(first?.firstSeen.toISOString());
    expect(second?.lastSeen.toISOString()).toBe(first?.lastSeen.toISOString());
    expect(Number(second?.lifetimeCount)).toBe(Number(first?.lifetimeCount));
  }, 60_000);
});
