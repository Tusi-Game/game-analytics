import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@common/(.*)$': '<rootDir>/common/$1',
    '^@config/(.*)$': '<rootDir>/config/$1',
    '^@database/(.*)$': '<rootDir>/database/$1',
    '^@redis/(.*)$': '<rootDir>/redis/$1',
    '^@queue/(.*)$': '<rootDir>/queue/$1',
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  // The live-infra integration specs open ioredis/TypeORM connections; force a
  // clean process exit so a lingering handle cannot hang the gate.
  forceExit: true,
  testTimeout: 30000,
  // Run serially (single worker). Several *.integration.spec.ts drive ONE shared
  // Redis + Postgres (the dev docker-compose services), and the dirty-registry is
  // a PLATFORM-scoped set (`ops:dirty:{domain}`, not per-game) — the production
  // model is one flush-drainer per domain. Under Jest's default parallelism two
  // suites' `sweep()`s race on that global set and steal each other's dirty keys,
  // producing flaky data-loss failures. Serial execution matches the real
  // single-drainer model and, because it removes the Redis contention, is also
  // FASTER here than the parallel run. Pure-unit specs are cheap, so the cost is nil.
  maxWorkers: 1,
};

export default config;
