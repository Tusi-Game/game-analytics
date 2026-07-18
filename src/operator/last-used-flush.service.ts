/**
 * last_used_at flush half (R7, T-10.20) — drains the resolver's Redis last-use
 * coalesce hashes into the credential child tables' `last_used_at` columns.
 *
 * The resolver stamps `{game}:ops:creduse` (hash: field `{kind}:{id}` → epoch ms,
 * LWW) on the hot path with NO Postgres write (see CredentialResolver). This
 * service is the periodic drainer: for each game it reads the hash, applies a
 * LWW `last_used_at` to each sdk/srv child row, and deletes the drained fields.
 * Slightly stale `last_used_at` is acceptable (the operator watches a rotated key
 * DRAIN, not to-the-second telemetry).
 *
 * WIRING SEAM (Unit B): call {@link drain} on the existing 5-min flush cadence
 * (FlushJobService.sweep / the BullMQ repeatable). It is intentionally NOT hooked
 * into the BullMQ worker registration here to avoid a workers→operator import
 * cycle + destabilizing the 002 flush path in Unit A; the logic is complete and
 * tested, and drain() is idempotent + best-effort (a Redis/PG hiccup is swallowed
 * per-field), so Unit B can bind it with one line.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { OpsKeys } from '../common/redis-keys/redis-keys';
import { GameEntity } from '../database/entities/game.entity';
import { GameSdkKeyEntity } from '../database/entities/game-sdk-key.entity';
import { GameServerCredentialEntity } from '../database/entities/game-server-credential.entity';

@Injectable()
export class LastUsedFlushService {
  private readonly logger = new Logger(LastUsedFlushService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * Drain every game's last-use coalesce hash into `last_used_at`. Returns the
   * number of credential rows stamped. Best-effort per field.
   */
  async drain(): Promise<number> {
    const games = await this.dataSource.getRepository(GameEntity).find({ select: { gameId: true } });
    let stamped = 0;
    for (const { gameId } of games) {
      stamped += await this.drainGame(gameId);
    }
    return stamped;
  }

  /** Drain a single game's coalesce hash (used by drain() and tests). */
  async drainGame(gameId: string): Promise<number> {
    const key = OpsKeys.credUse(gameId);
    const hash = await this.redis.hgetall(key);
    const fields = Object.keys(hash);
    if (fields.length === 0) {
      return 0;
    }
    let stamped = 0;
    for (const field of fields) {
      const ms = Number(hash[field]);
      if (!Number.isFinite(ms)) {
        await this.redis.hdel(key, field);
        continue;
      }
      const [kind, id] = field.split(':', 2);
      if ((kind !== 'sdk' && kind !== 'srv') || id === undefined || id.length === 0) {
        await this.redis.hdel(key, field);
        continue;
      }
      try {
        const at = new Date(ms);
        if (kind === 'sdk') {
          await this.dataSource.getRepository(GameSdkKeyEntity).update({ gameId, keyId: id }, { lastUsedAt: at });
        } else {
          await this.dataSource
            .getRepository(GameServerCredentialEntity)
            .update({ gameId, credentialId: id }, { lastUsedAt: at });
        }
        stamped += 1;
        await this.redis.hdel(key, field);
      } catch (err) {
        this.logger.debug(`last-use drain skipped ${gameId}/${field}: ${(err as Error).message}`);
      }
    }
    return stamped;
  }
}
