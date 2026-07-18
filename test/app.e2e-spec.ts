import { Global, INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DatabaseModule } from '../src/database/database.module';
import { RedisModule } from '../src/redis/redis.module';
import { QueueModule } from '../src/queue/queue.module';
import { REDIS_CLIENT } from '../src/redis/redis.constants';
import { INGEST_QUEUE_PROVIDER, INGEST_WORKER_CONNECTION } from '../src/queue/queue.constants';

/**
 * Inert stand-ins for the infrastructure modules so the app can boot without a
 * live Postgres/Redis for the health smoke test.
 */
@Global()
@Module({
  providers: [{ provide: DataSource, useValue: { query: jest.fn(), getRepository: jest.fn() } }],
  exports: [DataSource],
})
class FakeDatabaseModule {}

@Global()
@Module({
  providers: [{ provide: REDIS_CLIENT, useValue: { quit: jest.fn(), on: jest.fn() } }],
  exports: [REDIS_CLIENT],
})
class FakeRedisModule {}

@Global()
@Module({
  providers: [
    { provide: INGEST_QUEUE_PROVIDER, useValue: { close: jest.fn(), add: jest.fn() } },
    { provide: INGEST_WORKER_CONNECTION, useValue: { connection: { quit: jest.fn(), on: jest.fn() } } },
  ],
  exports: [INGEST_QUEUE_PROVIDER, INGEST_WORKER_CONNECTION],
})
class FakeQueueModule {}

/**
 * E2E: boots the Nest app and asserts GET /health returns 200 + { status: 'ok' }.
 *
 * Infrastructure is swapped for inert doubles so the health smoke test runs
 * without a live stack. A full boot against real Postgres/Redis is exercised via
 * docker-compose (design §4 / T-000.58) and via CI service containers.
 */
describe('Health (e2e)', () => {
  let app: INestApplication;

  const requiredEnv: Record<string, string> = {
    NODE_ENV: 'test',
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_USER: 'analytics',
    DB_PASSWORD: 'analytics',
    DB_NAME: 'analytics',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
  };

  beforeAll(async () => {
    for (const [key, value] of Object.entries(requiredEnv)) {
      process.env[key] = value;
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideModule(DatabaseModule)
      .useModule(FakeDatabaseModule)
      .overrideModule(RedisModule)
      .useModule(FakeRedisModule)
      .overrideModule(QueueModule)
      .useModule(FakeQueueModule)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('GET /health → 200 { status: "ok" }', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
    expect(typeof res.body.timestamp).toBe('number');
  });
});
