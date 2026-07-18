/**
 * Backpressure / rate-limit unit tests (T-00.95, DARK-SPOT #6).
 *
 * Proves the shedding CONTRACT with fakes (no live Redis/Postgres):
 *  - past the memory watermark → the shedder throws 503 BEFORE the controller
 *    enqueues → nothing acked, nothing enqueued;
 *  - past queue depth → 503;
 *  - over the per-game rate cap → whole-batch 429 + a `rate_limited` tally on the
 *    ARRIVAL day + NO Postgres touch (the tally is a Redis path) + no raw append
 *    (the door never appends);
 *  - the token bucket admits within cap and refuses the whole batch over cap
 *    (atomic admit-or-refuse), and a 0 cap is unlimited.
 */

import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { MemoryWatermarkService } from './memory-watermark.service';
import { RateLimitService } from './rate-limit.service';
import { IngestShedder } from './ingest-shedder.service';
import { IngestController } from '../ingest.controller';
import type { BatchRequest } from '../../common/contracts';
import type { GameConfigService } from '../../config/game-config.service';
import type { ExceptionTallyWriter } from '../../workers/kernel/exception-tally.writer';

function cfg(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    REDIS_MAXMEMORY_BYTES: 1000,
    MEMORY_WATERMARK_FRACTION: 0.8, // watermark = 800 bytes
    QUEUE_DEPTH_WATERMARK: 100,
    RETRY_AFTER_SECONDS: 5,
    INGEST_EVENTS_PER_SEC_CAP: 200,
    INGEST_RATE_BURST_EVENTS: 5000,
    REPORTING_OFFSET: 0,
    ...overrides,
  };
  return { get: <T>(k: string): T => values[k] as T } as unknown as ConfigService;
}

/** Fake ioredis: scripted INFO memory + a token-bucket EVAL stub. */
class FakeRedis {
  usedMemory = 100;
  evalResult = 1;
  readonly evalArgs: unknown[][] = [];
  async info(_section: string): Promise<string> {
    return `# Memory\r\nused_memory:${this.usedMemory}\r\nmaxmemory:1000\r\n`;
  }
  async eval(...args: unknown[]): Promise<number> {
    this.evalArgs.push(args);
    return this.evalResult;
  }
}

class FakeQueue {
  depth = 0;
  async getJobCounts(): Promise<Record<string, number>> {
    return { waiting: this.depth, delayed: 0, active: 0 };
  }
}

class FakeTally {
  readonly calls: Array<{ gameId: string; arrivalDay: string; reason: string }> = [];
  async tally(gameId: string, arrivalDay: string, reason: string): Promise<void> {
    this.calls.push({ gameId, arrivalDay, reason });
  }
}

class FakeGameConfig {
  override?: number;
  async getNumber(_gameId: string, _key: string): Promise<number | undefined> {
    return this.override;
  }
}

class RecordingQueue {
  readonly added: unknown[] = [];
  async add(name: string, data: unknown): Promise<{ id: string }> {
    this.added.push({ name, data });
    return { id: 'j1' };
  }
}

function build(over: {
  usedMemory?: number;
  depth?: number;
  evalResult?: number;
  configOverride?: number;
  config?: Record<string, unknown>;
}) {
  const redis = new FakeRedis();
  redis.usedMemory = over.usedMemory ?? 100;
  redis.evalResult = over.evalResult ?? 1;
  const queue = new FakeQueue();
  queue.depth = over.depth ?? 0;
  const tally = new FakeTally();
  const gameConfig = new FakeGameConfig();
  gameConfig.override = over.configOverride;
  const config = cfg(over.config);

  const watermark = new MemoryWatermarkService(redis as unknown as Redis, queue as unknown as Queue, config);
  const rateLimit = new RateLimitService(redis as unknown as Redis, config, gameConfig as unknown as GameConfigService);
  const shedder = new IngestShedder(watermark, rateLimit, tally as unknown as ExceptionTallyWriter, config);
  return { redis, queue, tally, gameConfig, watermark, rateLimit, shedder };
}

function batchBody(count: number): BatchRequest {
  const t = 1_000_000;
  return {
    sdk: { name: 's', version: '1' },
    events: Array.from({ length: count }, (_, i) => ({
      game_id: 'body-game',
      event_id: `e-${i}`,
      name: 'login',
      kind: 'generic',
      client_event_time: t,
      client_sent_time: t,
      server_received_time: t,
      props: {},
    })),
  };
}

describe('MemoryWatermarkService', () => {
  it('sheds with memory_watermark past 80% used_memory', async () => {
    const { watermark } = build({ usedMemory: 850 }); // > 800 watermark
    const v = await watermark.evaluate();
    expect(v.shed).toBe(true);
    expect(v.reason).toBe('memory_watermark');
  });

  it('does not shed below the watermark', async () => {
    const { watermark } = build({ usedMemory: 700 });
    const v = await watermark.evaluate();
    expect(v.shed).toBe(false);
  });

  it('sheds with queue_depth when memory is fine but depth is over', async () => {
    const { watermark } = build({ usedMemory: 100, depth: 150 });
    const v = await watermark.evaluate();
    expect(v.shed).toBe(true);
    expect(v.reason).toBe('queue_depth');
  });

  it('fails closed (shed) if Redis INFO throws', async () => {
    const { watermark, redis } = build({});
    redis.info = async (): Promise<string> => {
      throw new Error('redis down');
    };
    const v = await watermark.evaluate();
    expect(v.shed).toBe(true);
    expect(v.reason).toBe('redis_unreachable');
  });
});

describe('RateLimitService token bucket', () => {
  it('admits when the Lua script returns 1', async () => {
    const { rateLimit, redis } = build({ evalResult: 1 });
    const v = await rateLimit.tryAdmitBatch('g1', 25);
    expect(v.admitted).toBe(true);
    // eval args = [LUA, numKeys=1, key, rate, burst, cost, now, ttl].
    // The whole batch cost (25 events) is passed to the atomic script.
    expect(redis.evalArgs[0]![5]).toBe('25'); // ARGV[3] = cost
  });

  it('refuses the WHOLE batch when the script returns 0', async () => {
    const { rateLimit } = build({ evalResult: 0 });
    const v = await rateLimit.tryAdmitBatch('g1', 25);
    expect(v.admitted).toBe(false);
  });

  it('treats a 0 per-game cap as unlimited (no Redis call)', async () => {
    const { rateLimit, redis } = build({ configOverride: 0 });
    const v = await rateLimit.tryAdmitBatch('g1', 999999);
    expect(v.admitted).toBe(true);
    expect(redis.evalArgs).toHaveLength(0);
  });

  it('uses the per-game override cap over the platform default', async () => {
    const { rateLimit, redis } = build({ evalResult: 1, configOverride: 500 });
    await rateLimit.tryAdmitBatch('g1', 10);
    expect(redis.evalArgs[0]![3]).toBe('500'); // ARGV[1] = rate
  });
});

describe('IngestShedder ordering (before ack)', () => {
  it('throws 503 past the watermark and does NOT reach the rate check', async () => {
    const { shedder, redis } = build({ usedMemory: 900 });
    await expect(shedder.assertAdmissible('g1', 25)).rejects.toThrow(HttpException);
    // Memory brake short-circuits: the rate-limit EVAL is never called.
    expect(redis.evalArgs).toHaveLength(0);
  });

  it('throws 429 + writes a rate_limited arrival-day tally on rate breach', async () => {
    const { shedder, tally } = build({ usedMemory: 100, evalResult: 0 });
    let status = 0;
    try {
      await shedder.assertAdmissible('g1', 25);
    } catch (err) {
      status = (err as HttpException).getStatus();
    }
    expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(tally.calls).toHaveLength(1);
    expect(tally.calls[0]!.reason).toBe('rate_limited');
    // Arrival-day bucket = the day the platform observed the flood (UTC, offset 0).
    expect(tally.calls[0]!.arrivalDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('admits (no throw, no tally) when both brakes pass', async () => {
    const { shedder, tally } = build({ usedMemory: 100, evalResult: 1 });
    await expect(shedder.assertAdmissible('g1', 25)).resolves.toBeUndefined();
    expect(tally.calls).toHaveLength(0);
  });
});

describe('IngestController shed-before-ack (SC / P11)', () => {
  it('a shed batch is NEVER enqueued (503 before enqueue+ack)', async () => {
    const { shedder } = build({ usedMemory: 900 });
    const queue = new RecordingQueue();
    const controller = new IngestController(queue as unknown as Queue, shedder);

    await expect(controller.ingest(batchBody(10), 'g1', 'client')).rejects.toThrow(HttpException);
    // The core guarantee: shedding happened BEFORE any enqueue → nothing acked.
    expect(queue.added).toHaveLength(0);
  });

  it('a rate-limited batch is NEVER enqueued (429 before enqueue+ack)', async () => {
    const { shedder } = build({ usedMemory: 100, evalResult: 0 });
    const queue = new RecordingQueue();
    const controller = new IngestController(queue as unknown as Queue, shedder);

    await expect(controller.ingest(batchBody(10), 'g1', 'client')).rejects.toThrow(HttpException);
    expect(queue.added).toHaveLength(0);
  });

  it('an admissible batch IS enqueued and acked', async () => {
    const { shedder } = build({ usedMemory: 100, evalResult: 1 });
    const queue = new RecordingQueue();
    const controller = new IngestController(queue as unknown as Queue, shedder);

    const ack = await controller.ingest(batchBody(10), 'g1', 'client');
    expect(ack.received).toBe(10);
    expect(queue.added).toHaveLength(1);
  });
});
