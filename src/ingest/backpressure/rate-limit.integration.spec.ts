/**
 * Rate-limit token bucket + rate_limited tally against LIVE Redis (T-00.95).
 *
 * The unit spec stubs the Lua EVAL; this runs the REAL atomic token-bucket
 * script against Redis to prove:
 *  - a burst within the bucket is admitted, and once drained the WHOLE next batch
 *    is refused (atomic admit-or-refuse, never partial);
 *  - the shedder's 429 path writes a `rate_limited` tally to the arrival-day exc
 *    hash in Redis (NO Postgres touch — the tally rides the class-M Redis path).
 * Skips when Redis is unreachable.
 */

import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { HttpException } from '@nestjs/common';
import { connectRedisOrNull } from '../../testing/live-infra';
import { RateLimitService } from './rate-limit.service';
import { IngestShedder } from './ingest-shedder.service';
import { MemoryWatermarkService } from './memory-watermark.service';
import { ExceptionTallyWriter } from '../../workers/kernel/exception-tally.writer';
import { RehydrateService } from '../../common/redis-keys/rehydrate';
import { DirtyRegistry } from '../../workers/flush/dirty-registry';
import { EmptyFloorProvider } from '../../workers/kernel/default-hooks';
import { IngestKeys, OpsKeys } from '../../common/redis-keys/redis-keys';
import { arrivalBucketDay } from '../../common/kernel/logical-day';
import type { Redis } from 'ioredis';
import type { GameConfigService } from '../../config/game-config.service';

// Small cap + burst so the test drains the bucket in a few batches.
const cfg = {
  get: <T>(k: string): T => {
    const values: Record<string, unknown> = {
      INGEST_EVENTS_PER_SEC_CAP: 10,
      INGEST_RATE_BURST_EVENTS: 20,
      RETRY_AFTER_SECONDS: 5,
      REPORTING_OFFSET: 0,
      REDIS_MAXMEMORY_BYTES: 1_000_000_000_000, // effectively unlimited → no 503
      MEMORY_WATERMARK_FRACTION: 0.8,
      QUEUE_DEPTH_WATERMARK: 10_000_000,
    };
    return values[k] as T;
  },
} as unknown as ConfigService;

const noGameOverride = { getNumber: async () => undefined } as unknown as GameConfigService;

// A queue stub whose depth is always 0 (memory brake never trips here).
const fakeQueue = { getJobCounts: async () => ({ waiting: 0, delayed: 0, active: 0 }) } as unknown as Queue;

describe('Rate limit + rate_limited tally (live Redis)', () => {
  let redis: Redis | null = null;
  const GAME = `rl-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    redis = await connectRedisOrNull();
  });
  afterAll(async () => {
    if (redis) {
      const day = arrivalBucketDay(Date.now(), 0);
      await redis.del(OpsKeys.rateLimit(GAME), IngestKeys.cntExc(GAME, day));
      redis.disconnect();
    }
  });

  it('drains the burst then refuses the whole next batch (atomic)', async () => {
    if (!redis) return;
    const rl = new RateLimitService(redis, cfg, noGameOverride);

    // Burst = 20 tokens. Two batches of 10 admit; the third (10) is refused (the
    // bucket is empty and refill within the test window is negligible).
    expect((await rl.tryAdmitBatch(GAME, 10)).admitted).toBe(true);
    expect((await rl.tryAdmitBatch(GAME, 10)).admitted).toBe(true);
    expect((await rl.tryAdmitBatch(GAME, 10)).admitted).toBe(false);
  });

  it('the shedder 429s and writes a rate_limited tally to Redis (no Postgres)', async () => {
    if (!redis) return;
    const rl = new RateLimitService(redis, cfg, noGameOverride);
    const watermark = new MemoryWatermarkService(redis, fakeQueue, cfg);
    const tally = new ExceptionTallyWriter(
      redis,
      new RehydrateService(redis),
      new DirtyRegistry(redis),
      new EmptyFloorProvider(),
    );
    const shedder = new IngestShedder(watermark, rl, tally, cfg);

    // Drain the fresh bucket (burst 20), then a further batch must 429.
    const game = `${GAME}-shed`;
    await rl.tryAdmitBatch(game, 20);
    let threw = false;
    try {
      await shedder.assertAdmissible(game, 20);
    } catch (err) {
      threw = err instanceof HttpException && (err as HttpException).getStatus() === 429;
    }
    expect(threw).toBe(true);

    // The rate_limited tally landed on the arrival-day exc hash (Redis, class M).
    const day = arrivalBucketDay(Date.now(), 0);
    const count = await redis.hget(IngestKeys.cntExc(game, day), 'rate_limited');
    expect(Number(count)).toBeGreaterThanOrEqual(1);

    await redis.del(OpsKeys.rateLimit(game), IngestKeys.cntExc(game, day));
  });
});
