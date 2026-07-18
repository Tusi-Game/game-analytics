import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: '.*\\.e2e-spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@common/(.*)$': '<rootDir>/src/common/$1',
    '^@config/(.*)$': '<rootDir>/src/config/$1',
    '^@database/(.*)$': '<rootDir>/src/database/$1',
    '^@redis/(.*)$': '<rootDir>/src/redis/$1',
    '^@queue/(.*)$': '<rootDir>/src/queue/$1',
  },
  // The live-stack e2e opens BullMQ Worker + ioredis connections whose internal
  // schedulers can outlive app.close(); force a clean process exit so the gate
  // terminates deterministically instead of hanging on a lingering handle.
  forceExit: true,
  testTimeout: 30000,
  // Serial: the e2e specs share ONE Postgres + Redis, and the PITR DR drill
  // TRUNCATEs the results tables — running it concurrently with the ingest e2e
  // (which flushes into those same tables) would clobber the other's data. One
  // worker keeps the shared-stack e2e deterministic.
  maxWorkers: 1,
};

export default config;
