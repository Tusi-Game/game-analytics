import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { connectPostgresOrNull, connectRedisOrNull } from '../testing/live-infra';
import { CredentialService } from './credential.service';
import { CredentialResolver } from '../ingest/credential-resolver.service';
import { LastUsedFlushService } from './last-used-flush.service';
import { OpsKeys } from '../common/redis-keys/redis-keys';
import { GameEntity } from '../database/entities/game.entity';
import { GameSdkKeyEntity } from '../database/entities/game-sdk-key.entity';
import { GameServerCredentialEntity } from '../database/entities/game-server-credential.entity';
import type { Redis } from 'ioredis';

/**
 * R7 last_used_at pipeline against LIVE Postgres + Redis (T-10.20):
 *   - a resolve stamps the Redis coalesce hash (NO Postgres write on the path);
 *   - the flush drain writes it into the child row's last_used_at and clears the
 *     drained field (idempotent — a second drain is a no-op).
 * Skips when unreachable.
 */

const MASTER = 'lastuse-int-master';

function cfg(): ConfigService {
  return { get: (k: string) => (k === 'SECRET_MASTER_KEY' ? MASTER : undefined) } as unknown as ConfigService;
}

describe('last_used_at coalesce + flush (live Postgres + Redis)', () => {
  let ds: DataSource | null = null;
  let redis: Redis | null = null;
  const GAME = `lastuse-int-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    ds = await connectPostgresOrNull();
    redis = await connectRedisOrNull();
  });

  afterAll(async () => {
    if (ds) {
      await ds.getRepository(GameSdkKeyEntity).delete({ gameId: GAME });
      await ds.getRepository(GameServerCredentialEntity).delete({ gameId: GAME });
      await ds.getRepository(GameEntity).delete({ gameId: GAME });
      await ds.destroy();
    }
    if (redis) {
      await redis.del(OpsKeys.credUse(GAME));
      redis.disconnect();
    }
  });

  it('resolve stamps Redis; drain writes last_used_at and clears the hash', async () => {
    if (!ds || !redis) return;
    const svc = new CredentialService(ds, cfg());
    const resolver = new CredentialResolver(ds, cfg(), redis);
    const flush = new LastUsedFlushService(ds, redis);

    const reg = await svc.registerGame(GAME, 'Last-Use Game');
    // last_used_at starts null.
    let row = await ds.getRepository(GameSdkKeyEntity).findOneOrFail({ where: { gameId: GAME } });
    expect(row.lastUsedAt).toBeNull();

    // Resolve → stamps the coalesce hash (best-effort fire-and-forget).
    await resolver.resolve(reg.sdkKey.raw);
    await new Promise((r) => setImmediate(r));
    const hash = await redis.hgetall(OpsKeys.credUse(GAME));
    expect(Object.keys(hash).length).toBeGreaterThanOrEqual(1);

    // Drain → last_used_at is now set, and the hash is cleared.
    const stamped = await flush.drainGame(GAME);
    expect(stamped).toBeGreaterThanOrEqual(1);
    row = await ds.getRepository(GameSdkKeyEntity).findOneOrFail({ where: { gameId: GAME } });
    expect(row.lastUsedAt).not.toBeNull();
    expect(await redis.hgetall(OpsKeys.credUse(GAME))).toEqual({});

    // Idempotent — a second drain with nothing pending is a no-op.
    expect(await flush.drainGame(GAME)).toBe(0);
  });
});
