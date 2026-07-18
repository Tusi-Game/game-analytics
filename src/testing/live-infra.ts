/**
 * Test helpers for opting into LIVE Redis / Postgres.
 *
 * The integration tests need real services (Lua EVAL for the name-cap gate + cat
 * merge, real fsync + real SQL for the SC-008 / isolation proofs). They connect
 * using env `REDIS_HOST`/`REDIS_PORT` and `DB_*`; if a service is unreachable the
 * suite SKIPS (never fails the gate on a machine without the stack) — CI and the
 * dev docker-compose provide the services.
 *
 * NOTE: `docker compose up -d postgres redis` in this repo does not publish host
 * ports, so a local run points these env vars at the container IPs (see the test
 * runner). Reachability is probed once and cached.
 */

import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from '../database/snake-naming.strategy';
import { GameEntity } from '../database/entities/game.entity';
import { EventDayCountEntity } from '../database/entities/event-day-count.entity';
import { EventCatalogEntity } from '../database/entities/event-catalog.entity';
import { ExceptionTallyEntity } from '../database/entities/exception-tally.entity';
import { IdentityEdgeEntity } from '../database/entities/identity-edge.entity';
import { ErasureLedgerEntity } from '../database/entities/erasure-ledger.entity';
import { OperatorAccountEntity } from '../database/entities/operator-account.entity';
import { OperatorLoginAuditEntity } from '../database/entities/operator-login-audit.entity';
import { GameSdkKeyEntity } from '../database/entities/game-sdk-key.entity';
import { GameServerCredentialEntity } from '../database/entities/game-server-credential.entity';
import { ConfigAuditEntity } from '../database/entities/config-audit.entity';
import { GdprRequestAuditEntity } from '../database/entities/gdpr-request-audit.entity';

const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
const DB_HOST = process.env.DB_HOST ?? '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT ?? 5432);
const DB_USER = process.env.DB_USER ?? 'analytics';
const DB_PASSWORD = process.env.DB_PASSWORD ?? 'analytics';
const DB_NAME = process.env.DB_NAME ?? 'analytics';

/** Open a live Redis client, or null if unreachable within a short timeout. */
export async function connectRedisOrNull(): Promise<Redis | null> {
  const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 1500,
    retryStrategy: () => null,
  });
  try {
    await redis.connect();
    await redis.ping();
    return redis;
  } catch {
    redis.disconnect();
    return null;
  }
}

/** Open + initialize a live DataSource with the schema, or null if unreachable. */
export async function connectPostgresOrNull(): Promise<DataSource | null> {
  const ds = new DataSource({
    type: 'postgres',
    host: DB_HOST,
    port: DB_PORT,
    username: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    entities: [
      GameEntity,
      EventDayCountEntity,
      EventCatalogEntity,
      ExceptionTallyEntity,
      IdentityEdgeEntity,
      ErasureLedgerEntity,
      // 011 operator/admin registry entities (test-only synchronize builds them).
      OperatorAccountEntity,
      OperatorLoginAuditEntity,
      GameSdkKeyEntity,
      GameServerCredentialEntity,
      ConfigAuditEntity,
      GdprRequestAuditEntity,
    ],
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: true, // TEST-ONLY: build the schema in an ephemeral test DB.
    connectTimeoutMS: 1500,
  });
  try {
    await ds.initialize();
    return ds;
  } catch {
    return null;
  }
}
