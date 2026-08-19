import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { QueueModule } from './queue/queue.module';
import { REDIS_CLIENT } from './redis/redis.constants';
import { INGEST_QUEUE_PROVIDER, INGEST_WORKER_CONNECTION, COLD_STORAGE_QUEUE_PROVIDER } from './queue/queue.constants';

/**
 * Inert stand-ins for the infrastructure modules so the DI graph can be compiled
 * without a live Postgres/Redis. They export the same tokens (REDIS_CLIENT, the
 * BullMQ queue, the TypeORM DataSource) that story modules depend on, backed by
 * no-op doubles.
 */
@Global()
@Module({
  // The flush engine injects the TypeORM DataSource; provide a no-op double so
  // the graph compiles without a live Postgres.
  providers: [{ provide: DataSource, useValue: { query: jest.fn() } }],
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
    { provide: COLD_STORAGE_QUEUE_PROVIDER, useValue: { close: jest.fn(), add: jest.fn() } },
    { provide: INGEST_WORKER_CONNECTION, useValue: { connection: { quit: jest.fn(), on: jest.fn() } } },
  ],
  exports: [INGEST_QUEUE_PROVIDER, COLD_STORAGE_QUEUE_PROVIDER, INGEST_WORKER_CONNECTION],
})
class FakeQueueModule {}

/**
 * Smoke test: AppModule metadata resolves and the DI graph compiles.
 *
 * Infrastructure modules that would open live TCP connections are swapped for
 * inert doubles so the test needs no running Postgres/Redis. This proves the
 * module wiring is sound without a live stack (a full boot is covered by the
 * e2e test).
 */
describe('AppModule', () => {
  // Minimal env so the config loader (fail-fast on missing keys) is satisfied.
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

  beforeAll(() => {
    for (const [key, value] of Object.entries(requiredEnv)) {
      process.env[key] = value;
    }
  });

  it('compiles the dependency graph', async () => {
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

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });
});
