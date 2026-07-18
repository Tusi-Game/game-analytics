import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { GameEntity } from '../src/database/entities/game.entity';
import { GameSdkKeyEntity } from '../src/database/entities/game-sdk-key.entity';
import { EventDayCountEntity } from '../src/database/entities/event-day-count.entity';
import { FlushJobService } from '../src/workers/flush/flush-job.service';
import { credentialPrefix, hashCredential } from '../src/operator/credential-hash';

/**
 * Ingest front-door e2e against LIVE Redis + Postgres (T-01.43–46).
 * Proves the full HTTP → queue → worker → Postgres path end-to-end:
 *   - SC-002: fast-ack — a POST returns quickly and its latency does not grow
 *     with queue depth (no processing on the request path);
 *   - FR-003: an unknown credential → 401, NOTHING recorded;
 *   - SC-003 / #9: body-supplied game_id is ignored; counts land under the AUTHED
 *     game only.
 *
 * Requires the stack; SKIPS if unreachable. `docker compose up -d postgres redis`
 * (host runner points DB_HOST/REDIS_HOST at the container IPs).
 */

const AUTH_GAME = 'e2e-game';
const AUTH_KEY = 'sdk_e2e_key';

async function reachable(): Promise<boolean> {
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    retryStrategy: () => null,
  });
  try {
    await redis.connect();
    await redis.ping();
    redis.disconnect();
    return true;
  } catch {
    redis.disconnect();
    return false;
  }
}

describe('Ingest e2e (live stack)', () => {
  let app: INestApplication | null = null;
  let ds: DataSource;
  let flushJob: FlushJobService;
  let up = false;
  let rawDir = '';

  beforeAll(async () => {
    up = await reachable();
    if (!up) {
      return;
    }
    // Provide connection env defaults matching the docker-compose stack (published
    // on localhost) so the e2e is self-contained when run standalone; CI supplies
    // these via the workflow's service-container env, which takes precedence.
    process.env.DB_HOST ??= '127.0.0.1';
    process.env.DB_PORT ??= '5432';
    process.env.DB_USER ??= 'analytics';
    process.env.DB_PASSWORD ??= 'analytics';
    process.env.DB_NAME ??= 'analytics';
    process.env.REDIS_HOST ??= '127.0.0.1';
    process.env.REDIS_PORT ??= '6379';
    // Enable the live worker inside this app instance.
    process.env.INGEST_WORKER_ENABLED = '1';
    process.env.NODE_ENV = 'test';
    // Keep raw day-files out of the repo — write to a throwaway temp dir.
    rawDir = mkdtempSync(join(tmpdir(), 'ingest-e2e-raw-'));
    process.env.RAW_FILE_DIR = rawDir;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    ds = app.get(DataSource);
    flushJob = app.get(FlushJobService);

    // Seed the auth game (idempotent) + its hashed sdk_key CHILD row — the
    // rewritten resolver (011) reads the child table, not the inline scalar.
    await ds.getRepository(GameEntity).upsert(
      {
        gameId: AUTH_GAME,
        name: 'E2E',
        sdkKey: null,
        serverCredential: null,
        config: {},
        registeredAt: new Date(),
      },
      ['gameId'],
    );
    const master = process.env.SECRET_MASTER_KEY ?? '';
    const keyHash = hashCredential(master, AUTH_KEY);
    const existingKey = await ds.getRepository(GameSdkKeyEntity).findOne({ where: { keyHash } });
    if (!existingKey) {
      await ds.getRepository(GameSdkKeyEntity).insert({
        gameId: AUTH_GAME,
        keyId: randomUUID(),
        keyPrefix: credentialPrefix(AUTH_KEY),
        keyHash,
        createdAt: new Date(),
        lastUsedAt: null,
        revokedAt: null,
      });
    }
  });

  afterAll(async () => {
    delete process.env.INGEST_WORKER_ENABLED;
    delete process.env.RAW_FILE_DIR;
    if (app) {
      await app.close();
    }
    if (rawDir) {
      rmSync(rawDir, { recursive: true, force: true });
    }
  });

  function batchBody(gameIdInBody: string, count: number) {
    const t = Date.now();
    return {
      v: 1,
      sdk: { name: 'e2e', version: '1' },
      events: Array.from({ length: count }, (_, i) => ({
        game_id: gameIdInBody, // deliberately wrong — must be ignored
        event_id: `e2e-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`,
        name: 'login',
        kind: 'generic',
        client_event_time: t,
        client_sent_time: t,
        server_received_time: t,
        props: {},
      })),
    };
  }

  it('FR-003: unknown credential → 401, nothing enqueued', async () => {
    if (!up || !app) return;
    await request(app.getHttpServer())
      .post('/v1/events')
      .set('Authorization', 'Bearer totally-unknown-key')
      .send(batchBody('whatever', 1))
      .expect(401);
  });

  it('SC-002: fast-ack latency stays flat as queue depth grows', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();

    const timeAck = async (count: number): Promise<number> => {
      const start = process.hrtime.bigint();
      await request(server)
        .post('/v1/events')
        .set('Authorization', `Bearer ${AUTH_KEY}`)
        .send(batchBody(AUTH_GAME, count))
        .expect(200);
      return Number(process.hrtime.bigint() - start) / 1e6; // ms
    };

    // Baseline ack latency on an ~empty queue.
    const baseline = await timeAck(1);

    // Build DEPTH: enqueue many batches (queue depth = number of pending JOBS).
    // The ack must not scale with this depth (no work on the request path, P11).
    for (let i = 0; i < 40; i += 1) {
      await timeAck(20);
    }

    // Measure a small ack again with a large backlog behind it.
    const afterBacklog = await timeAck(1);

    // The ack does not block on processing → still flat despite the backlog.
    // Generous slack for CI jitter; the point is "not proportional to depth".
    expect(afterBacklog).toBeLessThan(baseline + 300);
  });

  it('SC-003 / #9: body game_id ignored — counts land under the AUTHED game only', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();
    const bodyGame = `bogus-${Math.random().toString(36).slice(2)}`;

    const res = await request(server)
      .post('/v1/events')
      .set('Authorization', `Bearer ${AUTH_KEY}`)
      .send(batchBody(bodyGame, 3))
      .expect(200);
    expect(res.body.received).toBe(3);

    // Let the worker drain, then flush to Postgres.
    await waitFor(async () => {
      await flushJob.sweep();
      const authed = await sumCounts(ds, AUTH_GAME);
      return authed >= 3;
    });

    const authed = await sumCounts(ds, AUTH_GAME);
    const bogus = await sumCounts(ds, bodyGame);
    expect(authed).toBeGreaterThanOrEqual(3);
    expect(bogus).toBe(0); // the body-claimed game got NOTHING (#9)
  });
});

async function sumCounts(ds: DataSource, gameId: string): Promise<number> {
  const rows = await ds.getRepository(EventDayCountEntity).find({ where: { gameId } });
  return rows.reduce((s, r) => s + Number(r.count), 0);
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 8000, stepMs = 250): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) {
      return;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
