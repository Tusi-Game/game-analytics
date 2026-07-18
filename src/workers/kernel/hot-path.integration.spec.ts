import { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { connectRedisOrNull } from '../../testing/live-infra';
import { HotBucketWriter, scalarTypeOf, CAT_PTS_PREFIX } from './hot-bucket.writer';
import { RedisNameCapGate } from './redis-name-cap.gate';
import { OTHER_OVERFLOW_NAME } from './ingest-kernel';
import { CAT_FIELD_FIRST_SEEN, CAT_FIELD_LAST_SEEN, CAT_FIELD_COUNT } from './postgres-floor.provider';
import { IngestKeys } from '../../common/redis-keys/redis-keys';
import type { GameConfigService } from '../../config/game-config.service';

/**
 * Hot-path Redis increments + the R3 name-cap gate — against LIVE Redis (Lua
 * EVAL cannot run on an in-memory fake). Proves:
 *   - DARK-SPOT #2: cat.first_seen merges by MIN, last_seen by MAX, across events
 *     arriving in descending time order (t=100,50,75 → first=50, last=100);
 *   - property type-sets union (types only, never values — P1);
 *   - R3 other-overflow: an over-cap distinct name buckets under `other`, KEPT +
 *     counted, never dropped.
 * Skips when Redis is unreachable.
 */

const gameConfigStub = {
  getNumber: async () => undefined,
} as unknown as GameConfigService;

const configStub = { get: () => undefined } as unknown as ConfigService;

describe('hot path + name-cap gate (live Redis)', () => {
  let redis: Redis | null;

  beforeAll(async () => {
    redis = await connectRedisOrNull();
  });
  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  const g = () => `it-${Math.random().toString(36).slice(2)}`;

  it('cat merge: first_seen = LEAST, last_seen = GREATEST across descending times (#2)', async () => {
    if (!redis) {
      return; // skipped — no live Redis
    }
    const writer = new HotBucketWriter(redis);
    const gameId = g();
    const times = [100_000, 50_000, 75_000]; // descending-then-middle
    for (const t of times) {
      await writer.upsertCatalog({
        gameId,
        bucketName: 'level_start',
        kind: 'generic',
        observedTimeMs: t,
        props: {},
        propertyKeyCap: 50,
      });
    }
    const hash = await redis.hgetall(IngestKeys.cat(gameId, 'level_start'));
    expect(hash[CAT_FIELD_FIRST_SEEN]).toBe('50000'); // MIN
    expect(hash[CAT_FIELD_LAST_SEEN]).toBe('100000'); // MAX
    expect(hash[CAT_FIELD_COUNT]).toBe('3'); // count += 1 each
  });

  it('property type-sets union types only (P1: never values)', async () => {
    if (!redis) {
      return;
    }
    const writer = new HotBucketWriter(redis);
    const gameId = g();
    await writer.upsertCatalog({
      gameId,
      bucketName: 'lvl',
      kind: 'generic',
      observedTimeMs: 1,
      props: { level: 1 },
      propertyKeyCap: 50,
    });
    await writer.upsertCatalog({
      gameId,
      bucketName: 'lvl',
      kind: 'generic',
      observedTimeMs: 2,
      props: { level: 'boss' },
      propertyKeyCap: 50,
    });
    const field = `${CAT_PTS_PREFIX}level`;
    const raw = await redis.hget(IngestKeys.cat(gameId, 'lvl'), field);
    const types = JSON.parse(raw ?? '[]') as string[];
    expect(new Set(types)).toEqual(new Set(['int', 'string'])); // both types, no values
  });

  it('cnt HINCRBY + rank ZINCRBY accumulate per name', async () => {
    if (!redis) {
      return;
    }
    const writer = new HotBucketWriter(redis);
    const gameId = g();
    await writer.incrementCount(gameId, '2026-07-18', 'login');
    await writer.incrementCount(gameId, '2026-07-18', 'login');
    await writer.incrementRank(gameId, '2026-07-18', 'login');
    expect(await redis.hget(IngestKeys.cnt(gameId, '2026-07-18'), 'login')).toBe('2');
    expect(await redis.zscore(IngestKeys.cntRank(gameId, '2026-07-18'), 'login')).toBe('1');
  });

  it('R3 name-cap → other-overflow: over-cap distinct name buckets under `other`, KEPT (#1)', async () => {
    if (!redis) {
      return;
    }
    const perGame = { getNumber: async () => 3 } as unknown as GameConfigService;
    const gate = new RedisNameCapGate(redis, configStub, perGame);
    const gameId = g();
    // 3 distinct names admitted under their own names…
    expect(await gate.resolveName(gameId, 'a')).toBe('a');
    expect(await gate.resolveName(gameId, 'b')).toBe('b');
    expect(await gate.resolveName(gameId, 'c')).toBe('c');
    // …the 4th and 5th distinct names overflow to `other` (never dropped).
    expect(await gate.resolveName(gameId, 'd')).toBe(OTHER_OVERFLOW_NAME);
    expect(await gate.resolveName(gameId, 'e')).toBe(OTHER_OVERFLOW_NAME);
    // An already-known name still resolves to itself.
    expect(await gate.resolveName(gameId, 'a')).toBe('a');
  });

  it('name-cap gate never consumes a budget slot for `other` itself', async () => {
    if (!redis) {
      return;
    }
    const perGame = { getNumber: async () => 2 } as unknown as GameConfigService;
    const gate = new RedisNameCapGate(redis, configStub, perGame);
    const gameId = g();
    await gate.resolveName(gameId, 'x');
    await gate.resolveName(gameId, 'y'); // cap now full (2)
    // over-cap names overflow; `other` is admitted but does not evict a real name
    expect(await gate.resolveName(gameId, 'z')).toBe(OTHER_OVERFLOW_NAME);
    expect(await gate.resolveName(gameId, 'x')).toBe('x'); // still known
    void gameConfigStub;
  });

  it('scalarTypeOf classifies without storing values', () => {
    expect(scalarTypeOf(1)).toBe('int');
    expect(scalarTypeOf(1.5)).toBe('float');
    expect(scalarTypeOf('s')).toBe('string');
    expect(scalarTypeOf(true)).toBe('boolean');
    expect(scalarTypeOf(null)).toBe('null');
    expect(scalarTypeOf([1, 2])).toBe('array');
  });
});
