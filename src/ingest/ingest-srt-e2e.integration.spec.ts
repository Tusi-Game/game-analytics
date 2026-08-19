/**
 * END-TO-END regression for the missing-`server_received_time` bug.
 *
 * A REAL SDK client omits both `game_id` and `server_received_time` (§1.1 —
 * server/collector-stamped). This drives an SDK-shaped session envelope through
 * the REAL ingest front door ({@link IngestController}) and then the REAL 9-step
 * kernel + session hooks against live Redis + Postgres, and proves:
 *
 *   1. WITH the door's stamp → the event is COUNTED and the session read shows 1.
 *   2. WITHOUT the stamp (raw SDK envelope) → the kernel throws on the NaN day
 *      (`server_received_time` undefined → skew → NaN corrected time), which is
 *      exactly why the worker was dropping every event and nothing was counted.
 *
 * Skips when the live stack is unreachable (same convention as the sibling
 * sessions-retention integration spec).
 */

import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Queue } from 'bullmq';

import { connectRedisOrNull, connectPostgresOrNull } from '../testing/live-infra';
import { IngestKernel, type KernelContext } from '../workers/kernel/ingest-kernel';
import { WindowedDedupGate, UnimplementedPurchaseDedupGate } from '../common/kernel/dedup';
import { RehydrateService } from '../common/redis-keys/rehydrate';
import { DirtyRegistry } from '../workers/flush/dirty-registry';
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
import type { EventEnvelope } from '../common/contracts/envelope';
import type { BatchRequest } from '../common/contracts';
import type { IngestBatchJob } from '../common/contracts/queue-jobs';

import { SessionValidator } from '../sessions/session-validator';
import { SessionDurableHook } from '../sessions/session-durable.hook';
import { SessionHotHook } from '../sessions/session-hot.hook';
import { SpineRepository } from '../sessions/spine.repository';
import { SessionFloorProvider } from '../sessions/session-floor.provider';
import { SessionConfigService } from '../sessions/session-config.service';
import { SessionReadService } from '../sessions/session-read.service';

import { IngestController } from './ingest.controller';
import type { IngestShedder } from './backpressure/ingest-shedder.service';

const configStub = { get: () => undefined } as unknown as ConfigService;
const noKnobs = {
  getNumber: async () => undefined,
  getBoolean: async () => true,
  getConfig: async () => ({}),
} as unknown as GameConfigService;

/** Captures the enqueued job so the test can feed it into the kernel. */
class FakeQueue {
  readonly added: IngestBatchJob[] = [];
  async add(_name: string, data: IngestBatchJob): Promise<{ id: string }> {
    this.added.push(data);
    return { id: 'job-x' };
  }
}
const passShedder = { assertAdmissible: async () => undefined } as unknown as IngestShedder;

interface Harness {
  kernel: IngestKernel;
  sessionRead: SessionReadService;
  dir: string;
}

function buildHarness(redis: Redis, ds: DataSource): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'srt-'));
  const rehydrate = new RehydrateService(redis);
  const dirty = new DirtyRegistry(redis);
  const sessionConfig = new SessionConfigService(noKnobs, configStub, 0);
  const spine = new SpineRepository(ds);
  const genericFloors = new PostgresFloorProvider(ds);
  const tally = new ExceptionTallyWriter(redis, rehydrate, dirty, genericFloors);
  const sessionFloors = new SessionFloorProvider(ds);

  const durableHook = new SessionDurableHook(spine, tally, sessionConfig);
  const hotHook = new SessionHotHook(redis, rehydrate, dirty, sessionFloors, sessionConfig);
  const genericHot = new GenericHotUpdateHook(rehydrate, dirty, genericFloors, new HotBucketWriter(redis), noKnobs);

  const dispatchValidator = new KindDispatchValidator(new PermissiveTypedValidator(), [
    { kind: 'session', validator: new SessionValidator() },
  ]);
  dispatchValidator.onModuleInit();
  const dispatchDurable = new KindDispatchDurableHook(new NoopDurableImmediateHook(), [
    { kind: 'session', hook: durableHook },
  ]);
  dispatchDurable.onModuleInit();
  const dispatchHot = new KindDispatchHotHook(genericHot, [{ kind: 'session', hook: hotHook }]);
  dispatchHot.onModuleInit();

  const rawFile = new RawFileService({ get: () => dir } as unknown as ConfigService, { dir, coldStorageEnabled: true });
  const kernel = new IngestKernel(
    rawFile,
    new WindowedDedupGate(redis),
    new UnimplementedPurchaseDedupGate(),
    new RedisNameCapGate(redis, configStub, noKnobs),
    dispatchValidator,
    dispatchDurable,
    dispatchHot,
    new WorkerAckPort(),
    new NoopPiiScrubPort(),
  );

  const sessionRead = new SessionReadService(redis, ds, sessionConfig);
  return { kernel, sessionRead, dir };
}

/** An SDK-shaped session envelope: NO game_id, NO server_received_time (§1.1). */
function sdkSessionEvent(sessionId: string, userId: string, now: number): BatchRequest['events'][number] {
  const start = now - 5 * 60_000;
  const end = now - 60_000;
  return {
    user_id: userId,
    session_id: sessionId,
    event_id: `${sessionId}-e`,
    name: 'session',
    kind: 'session',
    client_event_time: end,
    client_sent_time: end + 500,
    props: {
      session_id: sessionId,
      session_start_time: start,
      session_end_time: end,
      duration_ms: end - start,
      reason: 'timeout',
    },
  } as unknown as BatchRequest['events'][number];
}

function ctx(now: number): KernelContext {
  return { reportingOffsetMinutes: 0, now, provenance: 'client', batchJobId: 'srt-job' };
}

describe('server_received_time door-stamp — live e2e', () => {
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

  it('SDK envelope (no server_received_time) → door stamps it → session IS counted', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds);
    dirs.push(h.dir);
    const now = Date.now();
    const game = `g-srt-${Math.random().toString(36).slice(2)}`;
    const sessionId = `s-${Math.random().toString(36).slice(2)}`;

    // Drive the REAL front door with an SDK-shaped batch (no game_id / no SRT).
    const queue = new FakeQueue();
    const controller = new IngestController(queue as unknown as Queue, passShedder);
    const batch: BatchRequest = {
      sdk: { name: 'analytics-sdk', version: '1' },
      events: [sdkSessionEvent(sessionId, 'u-1', now)],
    };
    await controller.ingest(batch, game, 'client');

    const stamped = queue.added[0]!.events;
    // Sanity: the door filled in the field the SDK omitted.
    expect(typeof stamped[0]!.server_received_time).toBe('number');

    // Run the stamped event through the REAL kernel.
    const outcome = await h.kernel.process(stamped[0] as EventEnvelope, ctx(now));
    expect(outcome.counted).toBe(true);

    // The session read (live-merged open day) shows the count.
    const day = outcome.record!.corrected_day;
    const view = await h.sessionRead.sessionDay(game, day, now);
    expect(view.sessionCount).toBe(1);
  });

  it('CONTROL: the same SDK envelope WITHOUT the stamp makes the kernel throw (→ worker drop → 0)', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds);
    dirs.push(h.dir);
    const now = Date.now();
    // Raw SDK envelope with game_id stamped but SRT still missing (pre-fix door).
    const raw = {
      ...sdkSessionEvent(`s-ctl-${Math.random().toString(36).slice(2)}`, 'u-2', now),
      game_id: `g-ctl-${Math.random().toString(36).slice(2)}`,
    } as unknown as EventEnvelope;

    await expect(h.kernel.process(raw, ctx(now))).rejects.toThrow(/finite epoch-ms/);
  });
});
