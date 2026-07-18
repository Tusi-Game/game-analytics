import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { ReadModelService } from './read-model.service';
import { IngestKeys } from '../common/redis-keys/redis-keys';
import { SEEDED_MARKER_FIELD } from '../common/redis-keys/rehydrate';

/**
 * Dashboard read-model merge (T-01.41, §3.3). Proves the live-vs-historical merge
 * takes GREATEST per name (never a sum — the live hash rehydrated from the durable
 * floor), strips the reserved seeded marker, and derives the grand total read-time.
 */

function fakeRedis(hash: Record<string, string>): Redis {
  return {
    hgetall: async (key: string) => (key === IngestKeys.cnt('game-42', '2026-07-18') ? hash : {}),
  } as unknown as Redis;
}

function fakeDataSource(rows: Array<{ eventName: string; count: string }>): DataSource {
  return {
    getRepository: () => ({ find: async () => rows }),
  } as unknown as DataSource;
}

describe('ReadModelService merge', () => {
  it('merges live Redis + durable Postgres by GREATEST per name, marker stripped', async () => {
    const redis = fakeRedis({ login: '10', level_start: '3', [SEEDED_MARKER_FIELD]: '1' });
    const ds = fakeDataSource([
      { eventName: 'login', count: '8' }, // durable floor below live → live wins
      { eventName: 'purchase', count: '5' }, // durable-only (already sealed-ish)
    ]);
    const svc = new ReadModelService(redis, ds);
    const out = await svc.dayCounts('game-42', '2026-07-18');

    expect(out.perName.login).toBe(10); // GREATEST(10 live, 8 durable)
    expect(out.perName.level_start).toBe(3); // live-only
    expect(out.perName.purchase).toBe(5); // durable-only
    expect(out.liveTotal).toBe(18); // read-time Σ (no double-count of the floor)
    expect(out.provisional).toBe(true);
    expect(out.perName[SEEDED_MARKER_FIELD]).toBeUndefined(); // reserved field stripped
  });

  it('a fully-durable day (no live) is non-provisional', async () => {
    const redis = fakeRedis({});
    const ds = fakeDataSource([{ eventName: 'login', count: '100' }]);
    const svc = new ReadModelService(redis, ds);
    const out = await svc.dayCounts('game-42', '2026-07-18');
    expect(out.provisional).toBe(false);
    expect(out.liveTotal).toBe(100);
  });
});
