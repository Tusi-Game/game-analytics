# NestJS Project Scaffold — Design (Spec 000)

**Story spec:** [spec.md](./spec.md) · **Part of:** [001-analytics-platform](../001-analytics-platform/spec.md)
**Realizes:** FR-000–015, SC-000–003.
**Altitude:** project structure, module boundaries, contract shapes, tooling configuration. No app logic, no database entities, no API endpoint behaviors.

---

## 1. Module architecture

### 1.1 Directory tree

```
analytics/                                    # Git repo root
├── docker-compose.yml                        # Local dev stack
├── Dockerfile                                # Multi-stage: dev + prod
├── Dockerfile.dev                            # Dev-only (volume mount, watch mode)
├── .dockerignore
├── package.json
├── tsconfig.json                             # Strict TypeScript config
├── tsconfig.build.json                       # Build-specific (excludes tests)
├── nest-cli.json                             # NestJS CLI config
├── .eslintrc.js                              # ESLint + Prettier integration
├── .prettierrc                               # Prettier config
├── jest.config.ts                            # Unit test config
├── jest-e2e.config.ts                        # E2E test config
├── .husky/
│   └── pre-commit                            # lint-staged
├── .lintstagedrc.json                        # lint-staged config
├── .github/
│   └── workflows/
│       └── ci.yml                            # CI: checkout → install → lint → test → build
├── src/
│   ├── main.ts                               # NestFactory.create + view engine + static assets
│   ├── app.module.ts                         # Root module — imports all sub-modules
│   ├── common/
│   │   ├── contracts/
│   │   │   ├── envelope.ts                   # Canonical event envelope type (Foundation §1.1)
│   │   │   ├── batch.ts                      # Batch wrapper type {v, sdk, events[]}
│   │   │   ├── queue-jobs.ts                 # BullMQ job payload types
│   │   │   └── config.ts                     # Env config + GAME.config shape interfaces
│   │   ├── guards/
│   │   │   ├── sdk-key.guard.ts              # Extracts game_id + provenance from SDK key header
│   │   │   └── operator-session.guard.ts     # Placeholder — panel auth (spec 011 fills)
│   │   ├── pipes/
│   │   │   └── validation.pipe.ts            # Global Zod/class-validator pipe skeleton
│   │   ├── filters/
│   │   │   └── http-exception.filter.ts      # Global exception filter → structured 2xx/4xx/5xx
│   │   ├── decorators/
│   │   │   ├── game-id.decorator.ts          # @GameId() — extracts game_id from request context
│   │   │   └── provenance.decorator.ts       # @Provenance() — extracts provenance from auth
│   │   ├── interceptors/
│   │   │   └── logging.interceptor.ts        # Request logging + timing
│   │   └── common.module.ts                  # Exports all shared providers (Global module)
│   ├── config/
│   │   ├── env.ts                            # Typed env schema: DB_*, REDIS_*, MINIO_*, PORT, REPORTING_OFFSET
│   │   └── config.module.ts                  # @nestjs/config forRoot — load + validate
│   ├── database/
│   │   ├── entities/                         # Empty — stories add TypeORM entities here
│   │   ├── migrations/                       # Migration directory
│   │   └── database.module.ts                # TypeOrmModule.forRootAsync
│   ├── redis/
│   │   └── redis.module.ts                   # ioredis client provider (raw, no wrapper)
│   ├── queue/
│   │   └── queue.module.ts                   # BullMQ Queue + Worker wiring skeleton
│   ├── ingest/
│   │   ├── ingest.controller.ts              # POST /v1/events placeholder
│   │   └── ingest.module.ts                  # Import common + database + redis + queue
│   ├── workers/
│   │   ├── workers.module.ts                 # Imports queue; story processors registered here
│   │   └── processors/                       # Empty — stories add their BullMQ processors
│   ├── dashboard/
│   │   └── dashboard.module.ts               # Dashboard API (JSON read model, §3.3)
│   ├── panel/
│   │   ├── panel.module.ts                   # Nunjucks + ServeStatic + controller
│   │   ├── panel.controller.ts              # GET / → index.njk
│   │   ├── views/
│   │   │   ├── layout.njk                    # Base HTML shell (doctype, head, body)
│   │   │   └── index.njk                     # Placeholder home page
│   │   └── public/
│   │       ├── styles/
│   │       │   └── app.css                   # Tailwind input (or compiled output)
│   │       └── scripts/
│   │           └── .gitkeep                  # HTMX, Alpine, Chart.js — loaded via CDN or vendor bundle
│   └── seed.ts                               # Dev seed runner (placeholder, no data yet)
├── test/
│   ├── app.e2e-spec.ts                       # E2E: boot app, test /health returns 200
│   └── jest-e2e.json                         # E2E Jest config (or merged into jest-e2e.config.ts)
└── views/                                    # (Alternative location if nunjucks root differs)
```

### 1.2 Module dependency graph

```
AppModule
├── CommonModule      (Global — imported once, available everywhere)
├── ConfigModule       (Global, forRoot)
├── DatabaseModule     (forRoot — Postgres connection)
├── RedisModule        (exports ioredis client)
├── QueueModule        (depends on RedisModule)
├── IngestModule       (depends on Common, Database, Redis, Queue)
├── WorkersModule      (depends on Common, Database, Redis, Queue)
├── DashboardModule    (depends on Common, Database, Redis)
└── PanelModule        (depends on Common, Dashboard — renders views, calls Dashboard API)
```

**Rules:**
- `CommonModule` must be `@Global()` — every story module needs its guards, pipes, and contracts.
- `DatabaseModule` and `RedisModule` are infrastructure modules — imported by story modules that need them.
- `QueueModule` depends on `RedisModule` for the ioredis client; story modules import `QueueModule` to register workers.
- `PanelModule` calls `DashboardModule` controller methods directly (same process, no HTTP loopback) or shares a service layer.

### 1.3 Package dependencies

**Runtime (production):**
| Package | Purpose |
|---------|---------|
| `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` | NestJS core |
| `@nestjs/config` | Typed environment config |
| `@nestjs/typeorm`, `typeorm`, `pg` | Postgres ORM + driver |
| `ioredis` | Redis client (raw, also used by BullMQ) |
| `bullmq` | Queue + worker framework |
| `nunjucks` | Server-side template engine for panel |
| `reflect-metadata`, `rxjs` | NestJS decorator metadata + reactive streams |

**Dev:**
| Package | Purpose |
|---------|---------|
| `@nestjs/cli` | `nest build`, `nest start --watch` |
| `@nestjs/schematics` | `nest generate` scaffolding |
| `@nestjs/testing` | NestJS test utilities |
| `jest`, `ts-jest`, `@types/jest` | Test runner |
| `supertest`, `@types/supertest` | HTTP E2E testing |
| `eslint`, `@typescript-eslint/*`, `eslint-config-prettier`, `prettier` | Lint + format |
| `husky`, `lint-staged` | Pre-commit hooks |
| `typescript` | Compiler |
| `ts-node`, `tsconfig-paths` | Dev runner + path alias resolution |

**Not used (explicit exclusions):**
- `@nestjs/bullmq` — raw BullMQ only (FR-006 rationale)
- `@nestjs/swagger` — no OpenAPI in v1 (internal platform; panel is the UI)
- `class-validator`, `class-transformer` — Zod for validation (lighter, better TypeScript inference); decided at implementation time (Zod vs class-validator is a task-level choice, not a design constraint)

---

## 2. Contract interfaces (shared kernel)

### 2.1 Canonical event envelope (`common/contracts/envelope.ts`)

Binds the Foundation §1.1 envelope into a TypeScript type that every story imports. All stories reference this one type; none redefine it.

```typescript
// Shape only — not implementation
type EventKind = 'generic' | 'economy' | 'purchase' | 'session' | (string & {}); // open enum

interface EventEnvelope {
  game_id: string;          // Server-derived, never from body
  user_id?: string;
  anon_id?: string;
  session_id?: string;
  event_id: string;
  name: string;
  kind: EventKind;
  client_event_time: number;  // Unix ms
  client_sent_time: number;   // Unix ms
  server_received_time: number; // Unix ms
  props: Record<string, unknown>;
}
```

### 2.2 Batch wrapper (`common/contracts/batch.ts`)

```typescript
interface BatchRequest {
  v?: number;                 // Wire version (absent ⇒ 1)
  sdk: { name: string; version: string };
  events: EventEnvelope[];
}

interface BatchAck {
  received: number;           // Number of events accepted into queue
  batch_id: string;           // Server-assigned batch id for tracing
}
```

### 2.3 Queue job types (`common/contracts/queue-jobs.ts`)

```typescript
import { EventEnvelope } from './envelope';

interface RoutedRecord {
  envelope: EventEnvelope;
  v: number;                  // Effective wire version (stamped by front-door)
  corrected_time: number;     // Skew-corrected event-time (epoch ms)
  corrected_day: string;      // Logical day "YYYY-MM-DD" (reporting_offset applied)
  dedup_passed: boolean;
  sealed: boolean;            // True if day already sealed → quarantine
  provenance: 'client' | 'server';
}

interface IngestJob {
  batch_id: string;
  routed_records: RoutedRecord[];
}
```

### 2.4 Config interfaces (`common/contracts/config.ts`)

```typescript
interface EnvConfig {
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';
  REPORTING_OFFSET: number;                   // Minutes offset from UTC (e.g. 210 for +03:30)
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  MINIO_ENDPOINT: string;
  MINIO_PORT: number;
  MINIO_ACCESS_KEY: string;
  MINIO_SECRET_KEY: string;
  MINIO_BUCKET: string;
}

interface GameConfig {
  // Per-game knobs from GAME.config JSON column
  // Each story's §6 appends its knobs here at implementation time.
  // This interface starts empty and grows as stories are built.
  [key: string]: unknown;
}

interface GameRegistry {
  game_id: string;
  name: string;
  config: GameConfig;
  registered_at: Date;
}
```

---

## 3. NestJS wiring

### 3.1 `main.ts` bootstrap sequence

1. Create `NestFactory.create(AppModule)` with Express platform
2. Apply global exception filter (`HttpExceptionFilter`)
3. Apply global validation pipe
4. Apply global logging interceptor
5. Register Nunjucks view engine:
   - `nunjucks.configure('src/panel/views', { express: app, autoescape: true })`
   - Set view engine to `njk`
6. Serve static assets: `ServeStaticModule.forRoot({ rootPath: join(__dirname, '..', 'src/panel/public') })`
7. Enable CORS (optional, dev-only — reverse proxy handles in prod)
8. Listen on `PORT` (default 3000)

### 3.2 `app.module.ts` imports

```typescript
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [envConfig], validate }),
    DatabaseModule,
    RedisModule,
    QueueModule,
    CommonModule,        // @Global — available everywhere
    IngestModule,
    WorkersModule,
    DashboardModule,
    PanelModule,
  ],
})
export class AppModule {}
```

### 3.3 Route structure

| Method | Path | Module | Auth | Purpose |
|--------|------|--------|------|---------|
| GET | `/health` | App | None | Healthcheck |
| POST | `/v1/events` | Ingest | SDK key | Ingest endpoint (placeholder) |
| GET | `/` | Panel | Operator session (placeholder) | Panel home |

---

## 4. Docker Compose

```yaml
# Conceptual — actual file uses sha256-pinned images per FR-029/ops-envelope §9
services:
  app:
    build: { context: ., dockerfile: Dockerfile.dev }
    ports: ["3000:3000"]
    volumes: ["./src:/app/src"]   # Hot reload in dev
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment:
      - NODE_ENV=development
      - PORT=3000
      - REPORTING_OFFSET=0
      - DB_HOST=postgres, DB_PORT=5432, DB_USER=analytics, DB_PASSWORD=analytics, DB_NAME=analytics
      - REDIS_HOST=redis, REDIS_PORT=6379
      - MINIO_ENDPOINT=minio, MINIO_PORT=9000, MINIO_ACCESS_KEY=minioadmin, MINIO_SECRET_KEY=minioadmin, MINIO_BUCKET=analytics-raw
  postgres:
    image: <sha256 digest>  # postgres:16-alpine
    environment: [POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck: { test: "pg_isready -U analytics", interval: 5s }
  redis:
    image: <sha256 digest>  # redis:7-alpine
    command: redis-server --appendonly yes --appendfsync everysec --maxmemory-policy noeviction
    volumes: ["redisdata:/data"]
    healthcheck: { test: "redis-cli ping", interval: 5s }
  minio:
    image: <sha256 digest>  # minio/minio:latest
    command: server /data --console-address ":9001"
    environment: [MINIO_ROOT_USER, MINIO_ROOT_PASSWORD]
    volumes: ["miniodata:/data"]
  # Optional: reverse proxy (Caddy/Nginx) for TLS termination — added in a follow-up task

volumes: [pgdata, redisdata, miniodata]
```

**Dev-mode specifics:**
- Source code volume-mounted for hot reload — `Dockerfile.dev` runs `npm run dev` (nest start --watch)
- No TLS in local dev (reverse proxy is a separate task for prod/staging)
- Postgres and Redis persist data in named volumes (survives `docker-compose down`)

---

## 5. CI pipeline (GitHub Actions)

Single workflow: `.github/workflows/ci.yml`

```yaml
name: CI
on: [push, pull_request]
jobs:
  ci:
    runs-on: ubuntu-latest
    services:         # Postgres + Redis via GitHub service containers (no MinIO — e2e skip S3)
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4 with { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npm run lint
      - run: npm run format:check
      - run: npm run test
      - run: npm run test:e2e
      - run: npm run build
```

---

## 6. Relations with other specs

| Relation | Detail |
|----------|--------|
| **Blocks** | Every spec 002–012 — they all import from this skeleton |
| **Owns** | `CommonModule`, `ConfigModule`, `DatabaseModule`, `RedisModule`, `QueueModule`, `AppModule`, `main.ts`, Docker Compose, CI |
| **Written by** | None (this spec owns the skeleton) |
| **Consumed by** | 002 (T-00.1 moved here), 003–012 (all import contracts and modules) |
| **Replaces** | T-00.1 through T-00.7 in `002-foundation-ingest/tasks.md` — these tasks move here and are removed from 002 |
| **Does NOT own** | Any business entities, any API endpoint logic, any worker processors, any database entities |

### Ownership matrix (Foundation §5 extension)

| Structure | Store | Owner | Notes |
|-----------|-------|-------|-------|
| Project skeleton, tooling, CI | Disk/Git | 000 | Delivered once; every other spec builds inside it |
| `common/contracts/*` | Disk (TS types) | 000 | The single source of truth for all shared types |
| `common/guards/*`, `pipes/*`, `filters/*`, `decorators/*`, `interceptors/*` | Disk (NestJS) | 000 | Shared cross-cutting plumbing; stories use them, 000 maintains them |
| `config/env.ts` | Disk (TS + env vars) | 000 | Single typed env schema; stories add their own env vars here |
| Docker Compose | Disk | 000 | Dev env; 002 adds the AOF/RDB Redis config, 011 adds production override |
