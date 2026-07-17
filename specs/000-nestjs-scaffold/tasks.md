# Implementation Tasks — NestJS Project Scaffold (Spec 000)

**Story:** [spec.md](./spec.md) · **Design:** [design.md](./design.md) · **Part of:** [001-analytics-platform](../001-analytics-platform/spec.md)

This task list delivers the empty NestJS application skeleton, shared kernel interfaces, and development tooling. It replaces tasks T-00.1 through T-00.7 in `002-foundation-ingest/tasks.md` (which described scaffold tasks at a single-line level). Every subsequent spec builds inside this skeleton.

**Source spec:** [`spec.md`](./spec.md) (US0-1–3, FR-000–015) · **Design:** [`design.md`](./design.md) (module architecture, contracts, wiring, Docker, CI)

---

## 0. Scope & dependencies

No upstream dependencies — this is the first buildable unit. Delivers: NestJS project initialization, `src/` module tree with empty bounded modules, shared kernel TypeScript contract interfaces, TypeORM + ioredis + BullMQ wiring (connections only, no app logic), Docker Compose dev stack, ESLint + Prettier + Jest + Husky/lint-staged, and GitHub Actions CI.

**FR/SC this spec is accountable for:** FR-000–015, SC-000–003.

**Altitude:** project files, config files, type definitions, module declarations, connection wiring. No business logic, no endpoint behaviors beyond `/health`, no database entities, no worker processors.

---

## 1. Task list

### 1.1 NestJS project initialization

- [ ] **T-000.1** Initialize the NestJS project: `nest new analytics --package-manager npm --strict`. Clean up generated boilerplate (remove `app.controller.ts`, `app.service.ts`, `app.controller.spec.ts` — we provide our own skeleton).
- [ ] **T-000.2** Configure `tsconfig.json`: `strict: true`, `strictNullChecks: true`, `noUncheckedIndexedAccess: true`, path aliases (`@common/*`, `@config/*`, `@database/*`, `@redis/*`, `@queue/*` mapping to `src/*`).
- [ ] **T-000.3** Configure `tsconfig.build.json`: exclude `test/`, `**/*.spec.ts`, `**/*.e2e-spec.ts`.
- [ ] **T-000.4** Configure `nest-cli.json`: set source root, entry file, compiler options for the path aliases.

### 1.2 Module tree — empty bounded modules

- [ ] **T-000.5** Create `src/app.module.ts`: root module importing `ConfigModule`, `DatabaseModule`, `RedisModule`, `QueueModule`, `CommonModule`, `IngestModule`, `WorkersModule`, `DashboardModule`, `PanelModule`. No app logic — just imports.
- [ ] **T-000.6** Create `src/main.ts`: `NestFactory.create(AppModule)`, register Nunjucks view engine, serve static assets, global exception filter, global validation pipe, global logging interceptor, listen on `PORT`.
- [ ] **T-000.7** Create `src/common/common.module.ts` — `@Global()` module exporting contracts, guards, pipes, filters, decorators, interceptors from one barrel. Providers are skeletal (guards return `true`, filter logs and passes through, pipe is `ValidationPipe` skeleton).
- [ ] **T-000.8** Create `src/ingest/ingest.module.ts` — imports `CommonModule`, `DatabaseModule`, `RedisModule`, `QueueModule`. Controller with `POST /v1/events` returning `{ received: 0 }` placeholder.
- [ ] **T-000.9** Create `src/workers/workers.module.ts` — imports `QueueModule`. Empty `processors/` directory with a `.gitkeep`. Skeleton for story workers to register in.
- [ ] **T-000.10** Create `src/dashboard/dashboard.module.ts` — imports `CommonModule`, `DatabaseModule`, `RedisModule`. Empty module; stories add read-model controllers.
- [ ] **T-000.11** Create `src/panel/panel.module.ts` — imports `ServeStaticModule` (pointing to `panel/public/`), controller rendering `views/index.njk`. Create `views/layout.njk` (base HTML shell with doctype, head, body) and `views/index.njk` (placeholder "Analytics Platform" home). Create `public/styles/.gitkeep` and `public/scripts/.gitkeep`.

### 1.3 Infrastructure modules — connection wiring only

- [ ] **T-000.12** Install runtime dependencies: `npm install @nestjs/common @nestjs/core @nestjs/platform-express @nestjs/config @nestjs/typeorm typeorm pg ioredis bullmq nunjucks reflect-metadata rxjs`.
- [ ] **T-000.13** Install dev dependencies: `npm install --save-dev @nestjs/cli @nestjs/schematics @nestjs/testing jest ts-jest @types/jest supertest @types/supertest eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser eslint-config-prettier prettier husky lint-staged typescript ts-node tsconfig-paths`.
- [ ] **T-000.14** Create `src/config/env.ts`: typed `EnvConfig` interface + `envConfig()` loader function using `process.env` with defaults. Validate required keys at boot (fail fast on missing `DB_*`, `REDIS_*`).
- [ ] **T-000.15** Create `src/config/config.module.ts`: `ConfigModule.forRoot({ isGlobal: true, load: [envConfig] })`.
- [ ] **T-000.16** Create `src/database/database.module.ts`: `TypeOrmModule.forRootAsync` using `ConfigService` to read DB connection params. Create empty `entities/` directory with `.gitkeep` and empty `migrations/` directory with `.gitkeep`.
- [ ] **T-000.17** Create `src/redis/redis.module.ts`: export an ioredis `Redis` client provider, configured from `ConfigService`. Single client — no cluster, no sentinel. Include a `REDIS_CLIENT` injection token.
- [ ] **T-000.18** Create `src/queue/queue.module.ts`: export a BullMQ `Queue` provider (named `ingest-queue`) and a `Worker` skeleton using the ioredis client from `RedisModule`. No processors defined yet — just the queue + worker connection plumbing.

### 1.4 Shared kernel contracts

- [ ] **T-000.19** Create `src/common/contracts/envelope.ts`: `EventKind` type (open string union), `EventEnvelope` interface per Foundation §1.1.
- [ ] **T-000.20** Create `src/common/contracts/batch.ts`: `BatchRequest` and `BatchAck` interfaces.
- [ ] **T-000.21** Create `src/common/contracts/queue-jobs.ts`: `RoutedRecord` and `IngestJob` interfaces.
- [ ] **T-000.22** Create `src/common/contracts/config.ts`: `EnvConfig`, `GameConfig`, `GameRegistry` interfaces.
- [ ] **T-000.23** Create `src/common/contracts/index.ts` — barrel file re-exporting all contracts.

### 1.5 Shared NestJS cross-cutting plumbing

- [ ] **T-000.24** Create `src/common/guards/sdk-key.guard.ts`: guard that reads SDK key from `Authorization: Bearer <key>` header, extracts `game_id` and `provenance` into request context. **Skeleton only** — returns a hardcoded test game_id or `true` in dev; real auth is spec 011's concern. Document the contract: `game_id` on `request.game_id`, `provenance` on `request.provenance`.
- [ ] **T-000.25** Create `src/common/guards/operator-session.guard.ts`: placeholder guard for panel routes. Returns `true` (no-op) — real auth is spec 011's concern.
- [ ] **T-000.26** Create `src/common/guards/index.ts` — barrel file.
- [ ] **T-000.27** Create `src/common/decorators/game-id.decorator.ts`: `@GameId()` param decorator extracting `game_id` from request context (`request.game_id`).
- [ ] **T-000.28** Create `src/common/decorators/provenance.decorator.ts`: `@Provenance()` param decorator extracting provenance from request context.
- [ ] **T-000.29** Create `src/common/decorators/index.ts` — barrel file.
- [ ] **T-000.30** Create `src/common/pipes/validation.pipe.ts`: skeleton validation pipe (extends `ValidationPipe` or wraps Zod). Placeholder — spec 002 adds real batch validation.
- [ ] **T-000.31** Create `src/common/filters/http-exception.filter.ts`: global exception filter. Catches all exceptions, logs them, returns structured JSON `{ statusCode, message, timestamp }`. **Skeleton only** — returns 500 for unhandled, does NOT yet enforce the "always 2xx ack" rule (that's spec 002's behavior).
- [ ] **T-000.32** Create `src/common/interceptors/logging.interceptor.ts`: request logging interceptor — logs method, URL, response time in ms. Uses NestJS `Logger`.
- [ ] **T-000.33** Update `src/common/common.module.ts`: register and export all guards (`APP_GUARD` for global SDK-key guard on ingest routes), pipes, filters (`APP_FILTER`), interceptors (`APP_INTERCEPTOR`), and decorators.

### 1.6 Health endpoint

- [ ] **T-000.34** Add `GET /health` endpoint returning `{ status: "ok", uptime: process.uptime(), timestamp: Date.now() }`. Add to `app.module.ts` via a simple inline controller or a dedicated `health.controller.ts`.

### 1.7 Docker Compose + containerization

- [ ] **T-000.35** Create `Dockerfile`: multi-stage build. Stage 1: `node:20-alpine` installs dependencies + builds. Stage 2: `node:20-alpine` runs `node dist/main.js`. Non-root user.
- [ ] **T-000.36** Create `Dockerfile.dev`: single-stage `node:20-alpine`, installs dependencies, runs `npm run dev` (nest start --watch). Source volume-mounted.
- [ ] **T-000.37** Create `.dockerignore`: exclude `node_modules`, `dist`, `.git`, `test`, `*.md`, `docker-compose.yml`, `Dockerfile*`.
- [ ] **T-000.38** Create `docker-compose.yml`: services `app`, `postgres`, `redis`, `minio` per design §4. `app` builds from `Dockerfile.dev` with source volume mount, port `3000:3000`, depends on postgres + redis with healthchecks. Postgres uses `postgres:16-alpine` (**pinned by sha256 digest**). Redis uses `redis:7-alpine` (**pinned by sha256 digest**) with `--appendonly yes --appendfsync everysec --maxmemory-policy noeviction`. MinIO pinned by sha256. Named volumes `pgdata`, `redisdata`, `miniodata`. Env vars passed through.
- [ ] **T-000.39** Document the offline `docker save`/`load` procedure for air-gapped install in a `docs/docker-offline.md` — *cite:* ops-envelope §9, sanctions constraint.

### 1.8 Linting, formatting, pre-commit

- [ ] **T-000.40** Configure ESLint: `.eslintrc.js` with `@typescript-eslint` parser, NestJS recommended rules, Prettier integration (`eslint-config-prettier`). Rules: `@typescript-eslint/no-unused-vars` (error), `@typescript-eslint/explicit-function-return-type` (off — TypeScript inference is preferred).
- [ ] **T-000.41** Configure Prettier: `.prettierrc` — `{ "singleQuote": true, "trailingComma": "all", "printWidth": 120, "tabWidth": 2, "semi": true }`.
- [ ] **T-000.42** Add npm scripts: `lint` (`eslint src test`), `format` (`prettier --write src test`), `format:check` (`prettier --check src test`).
- [ ] **T-000.43** Configure Husky + lint-staged: `npx husky init`, create `.husky/pre-commit` running `npx lint-staged`. Create `.lintstagedrc.json`: `{ "*.ts": ["prettier --write", "eslint --fix"] }`.
- [ ] **T-000.44** Run `npm run format` on all generated source files so the initial commit is clean.

### 1.9 Testing infrastructure

- [ ] **T-000.45** Configure `jest.config.ts`: `ts-jest` preset, rootDir `src`, test regex `.*\.spec\.ts$`, module name mapper for path aliases (`@common/`, `@config/`, etc.).
- [ ] **T-000.46** Configure `jest-e2e.config.ts`: `ts-jest` preset, rootDir `test`, test regex `.*\.e2e-spec\.ts$`, module name mapper for path aliases.
- [ ] **T-000.47** Create `src/app.module.spec.ts`: smoke test — verifies `AppModule` compiles and bootstraps.
- [ ] **T-000.48** Create `src/common/contracts/envelope.spec.ts`: type-level test — TypeScript compilation test that `EventEnvelope` matches Foundation §1.1 (key existence, optional fields). Uses `expectTypeOf` or a simple assignability assertion.
- [ ] **T-000.49** Create `test/app.e2e-spec.ts`: E2E test — boots the app with `supertest`, calls `GET /health`, asserts `200` and `{ status: "ok" }`. Runs against docker-compose-booted services (or testcontainers if configured).
- [ ] **T-000.50** Add npm scripts: `test` (`jest`), `test:watch` (`jest --watch`), `test:e2e` (`jest --config jest-e2e.config.ts`), `test:cov` (`jest --coverage`).

### 1.10 CI pipeline

- [ ] **T-000.51** Create `.github/workflows/ci.yml`: GitHub Actions workflow triggering on `push` and `pull_request`. Job: `ubuntu-latest`, Node 20, `npm ci`, `npm run lint`, `npm run format:check`, `npm run test`, `npm run test:e2e`, `npm run build`. Postgres and Redis as service containers. No MinIO service (E2E tests skip S3-dependent paths).

### 1.11 Package.json scripts

- [ ] **T-000.52** Add `dev` script: `nest start --watch`.
- [ ] **T-000.53** Add `build` script: `nest build`.
- [ ] **T-000.54** Add `start` script: `node dist/main.js`.
- [ ] **T-000.55** Add `seed` script: `ts-node src/seed.ts` (placeholder — no data seeded yet).
- [ ] **T-000.56** Create `src/seed.ts`: bootstrap NestJS app with `AppModule`, log "Seed complete — no data yet." Placeholder for future seed data scripts.

### 1.12 Final verification

- [ ] **T-000.57** Verify clean checkout flow: `npm ci && npm run lint && npm run format:check && npm run test && npm run test:e2e && npm run build` — all exit 0.
- [ ] **T-000.58** Verify Docker flow: `docker-compose up` starts without errors, `curl http://localhost:3000/health` returns 200, `docker-compose down` cleans up.
- [ ] **T-000.59** Update `002-foundation-ingest/tasks.md`: remove T-00.1 through T-00.7 (they are now realized here). Replace with a reference: "The scaffold is delivered by [000-nestjs-scaffold](../000-nestjs-scaffold/tasks.md)."

---

## 2. Cross-story impacts

| Impact | Action |
|--------|--------|
| **002 tasks** | Remove T-00.1–T-00.7 (scaffold tasks). Replace with pointer to this spec. |
| **All story designs (002–012)** | Reference `CommonModule`, `DatabaseModule`, `RedisModule`, `QueueModule` from this scaffold. No story creates its own NestJS project or Docker Compose. |
| **Constitution** | No change — no new principles. The scaffold enables P4 (single-command deploy) and P11 (fast-ack door). |
| **001 PLAN-INDEX** | Add this spec before Stage A in the build order. Entry criterion for Stage A: the scaffold must be fully built and verified. |
