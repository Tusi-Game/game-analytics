# NestJS Project Scaffold (Spec 000)

**Part of:** [001-analytics-platform](../001-analytics-platform/spec.md)
**Phase:** Pre-foundation — must complete before Stage A (substrate)
**Status:** Draft (2026-07-18)
**Depends on:** nothing — this is the first buildable unit, delivering the empty NestJS application every other spec builds inside.

---

## 1. Purpose

This spec delivers the **empty NestJS + TypeScript monorepo** — the project skeleton, shared kernel interfaces, and development tooling — before any application logic exists. Every subsequent spec (002–012) assumes this skeleton exists and imports its shared contracts.

**What it is NOT:** This spec does not implement any business logic. No envelope validation, no Redis key grammar runtime, no BullMQ worker, no database entities, no API endpoint logic. It establishes the *boundaries*, *contracts*, and *infrastructure* that make those possible.

---

## 2. User stories

### US0-1 — Developer clones and runs in one command

A developer clones the repo, runs `docker-compose up`, and gets a running NestJS app connected to Postgres, Redis, and MinIO — with hot-reload in dev mode. No manual setup, no external services, no cloud dependency.

**Acceptance:** `docker-compose up` starts without errors. `curl http://localhost:3000/health` returns 200.

### US0-2 — Developer writes a new story module against shared contracts

A developer creating spec 002 creates `src/ingest/` with a controller and service, imports `CommonModule` for the envelope types, auth guard, and config, and wires a TypeORM entity — all without touching files outside their module directory.

**Acceptance:** Adding `ingest.module.ts` with `imports: [CommonModule, DatabaseModule, RedisModule, QueueModule]` compiles and the app boots.

### US0-3 — Developer has confidence the scaffold is correct

Lint passes, tests pass, build succeeds, pre-commit hooks catch issues before push, CI runs on every PR. The scaffold has zero warnings and zero skipped tests.

**Acceptance:** `npm run lint`, `npm run test`, `npm run build` all exit 0 on a clean checkout.

---

## 3. Functional requirements

| ID | Requirement |
|----|------------|
| FR-000 | **NestJS monorepo.** Single NestJS process hosting all modules (ingest, workers, dashboard, panel). Flat `src/` directory structure. |
| FR-001 | **Module boundaries.** Five top-level modules — `common`, `ingest`, `workers`, `dashboard`, `panel` — each with its own `*.module.ts`. `app.module.ts` imports all five. |
| FR-002 | **Shared kernel.** `CommonModule` exports typed contract interfaces (envelope, batch, queue jobs, config), guards (SDK-key auth, operator session), pipes, filters, decorators, and interceptors. Zero app logic; pure contracts and NestJS cross-cutting plumbing. |
| FR-003 | **Config module.** Typed environment configuration (DB, Redis, MinIO, server port, `reporting_offset`) loaded at boot. Validates required keys and fails fast on missing config. |
| FR-004 | **Database connectivity.** TypeORM wired to Postgres with `forRoot` in `DatabaseModule`. Entity directory exists but is empty. Migration directory scaffolded. |
| FR-005 | **Redis connectivity.** `RedisModule` exports a configured ioredis client. No BullMQ wrapper (`@nestjs/bullmq` is NOT used). |
| FR-006 | **Queue skeleton.** `QueueModule` wires BullMQ raw (using the ioredis client from RedisModule). Queue and worker registration skeleton exists; no processors defined yet. |
| FR-007 | **SSR panel foundation.** `PanelModule` registers Nunjucks as the view engine (`nunjucks` npm package, not `@nestjs/platform-express` views). Serves static assets from `panel/public/`. A placeholder index route (`/`) renders `views/index.njk`. |
| FR-008 | **Health endpoint.** `GET /health` returns `{ status: "ok", uptime: ... }`. Serves as the docker-compose healthcheck target and the first-smoke-test after clone. |
| FR-009 | **Docker Compose.** Single `docker-compose.yml` with services: `app` (NestJS, dev mode with hot-reload via volume mount), `postgres`, `redis`, `minio`. `app` depends on `postgres` and `redis` with healthchecks. |
| FR-010 | **TypeScript strict mode.** `tsconfig.json` with `strict: true`, `strictNullChecks`, `noUncheckedIndexedAccess`. Path alias `@common`, `@config`, `@database`, `@redis`, `@queue`. |
| FR-011 | **Linting and formatting.** ESLint with NestJS defaults + Prettier. `npm run lint` and `npm run format:check` exit 0. |
| FR-012 | **Testing infrastructure.** Jest configured for unit and e2e tests. `npm run test` and `npm run test:e2e` exit 0 on sample tests. E2E tests use Testcontainers or docker-compose-booted services. |
| FR-013 | **CI pipeline.** GitHub Actions workflow: checkout → install → lint → test → build. Runs on every push and PR. |
| FR-014 | **Pre-commit hooks.** Husky + lint-staged: staged `.ts` files are auto-formatted (Prettier) and linted (ESLint) on commit. |
| FR-015 | **Dev convenience.** `npm run dev` starts in watch mode via `nest start --watch`. `npm run seed` runs the seed script (placeholder, no data yet). |

---

## 4. Success criteria

| ID | Criterion | Measurement |
|----|-----------|-------------|
| SC-000 | **Single-command bootstrap.** Cloned repo starts with `docker-compose up` with no manual steps. | Timed: < 2 min on first pull (image downloads), < 30 s on subsequent starts. |
| SC-001 | **All quality gates green on clean checkout.** | `npm run lint && npm run test && npm run build` all exit 0. |
| SC-002 | **Every subsequent spec uses only this skeleton.** No spec 002–012 creates a new NestJS project, a new TypeScript config, or a new Docker Compose. | Audit: all `specs/002-012/*/design.md` reference `CommonModule`, `DatabaseModule`, etc. — never define an alternative scaffold. |
| SC-003 | **Dev feedback loop < 3 s.** TypeScript compilation on change (watch mode) completes in under 3 seconds for the skeleton. | Timed from file save to "Compilation complete" in terminal. |

---

## 5. Assumptions & constraints

- **NestJS monolith, not microservices.** One `NestFactory.create(AppModule)` call in `main.ts`. All modules live in one process (Clarifications from 001 spec).
- **Package manager:** npm (matches NestJS defaults; no pnpm/yarn/bun complexity for v1).
- **Node version:** Node 20 LTS (active LTS at time of writing).
- **Docker base image:** `node:20-alpine` for the app service.
- **No `@nestjs/bullmq`.** Queue wiring uses raw BullMQ + ioredis. The `@nestjs/bullmq` wrapper adds indirection without benefit for our single-queue, raw-control posture (Foundation backpressure/rate-limiting needs direct BullMQ access).
- **No separate frontend.** The panel is server-rendered inside NestJS (Nunjucks + Tailwind + HTMX + Alpine.js + Chart.js). There is no React/Vue/Angular frontend app.
- **CI uses GitHub Actions.** Assumes the repo is hosted on GitHub. Adaptable if hosted elsewhere, but v1 CI is GitHub Actions only.
- **Docker Compose for local dev only.** Production deployment pattern is out of scope for this spec (production configs are spec 011's concern).
