# Game Analytics Platform

A **self-hostable, multi-game** analytics platform for Phaser.js / React games with
NestJS backends. Built to run on a single VPS in restricted / air-gapped networks —
because GameAnalytics and Google Analytics aren't usable everywhere.

One install serves many games. Events land through a fast-ack HTTP front door, get
processed off the hot path by a Redis-backed queue, and only **processed results**
land in Postgres — never raw event logs. Raw events survive as disposable daily
gzip files that ship to S3-compatible storage and are then deleted locally.

- **Never breaks gameplay** — the client SDK returns after a durable enqueue; transport and retry run off the hot path and never throw into game code.
- **Money is truth, and only from the server** — revenue rows come exclusively from your trusted backend via the server SDK; the embeddable client SDK can never mint revenue.
- **Runs where the big vendors can't** — single `docker compose up`, digest-pinned images, offline install path, no outbound calls to a SaaS.

> **Status:** implementation in progress. The scaffold, ingest/foundation, sessions,
> retention, economy, monetization, derived KPIs, cold storage, both SDKs, operator
> admin, and the operator panel are implemented (specs `000`–`012`). This is a young
> project — expect rough edges. See [Roadmap](#roadmap).

---

## Table of contents

- [Architecture](#architecture)
- [What it measures](#what-it-measures)
- [Quick start](#quick-start)
- [Instrumenting a game](#instrumenting-a-game)
- [HTTP surface](#http-surface)
- [Storage model](#storage-model)
- [Operator panel & admin API](#operator-panel--admin-api)
- [Privacy & GDPR](#privacy--gdpr)
- [Security posture](#security-posture)
- [Deployment](#deployment)
- [Development](#development)
- [Project layout](#project-layout)
- [Roadmap](#roadmap)
- [License](#license)

---

## Architecture

```
  Game (browser)                    Your backend
  ┌──────────────┐                  ┌──────────────┐
  │ client SDK   │                  │ server SDK   │
  │ pk_… (public)│                  │ sk_… (secret)│
  └──────┬───────┘                  └──────┬───────┘
         │  POST /v1/events (batched, gzip)       │
         ▼                                        ▼
   ┌───────────────────────────────────────────────────┐
   │ Ingest front door  — auth guard, shallow parse,    │
   │ stamp game_id + provenance, enqueue, fast-ack 200  │
   └───────────────────────┬───────────────────────────┘
                           │ opaque batch job
                           ▼
                   ┌───────────────┐        ┌──────────────┐
                   │ Redis (BullMQ)│        │ raw day-file │
                   │ queue + hot   │        │ (write-ahead │
                   │ counters ≤1d  │        │  gzip)       │
                   └───────┬───────┘        └──────┬───────┘
                           │ workers                 │ nightly seal
                           ▼                         ▼
              ┌────────────────────────┐     ┌──────────────┐
              │ flush engine → Postgres │     │ S3 / MinIO   │
              │ user spine + rollups    │     │ cold storage │
              └────────────┬───────────┘     └──────────────┘
                           │ read-model
                           ▼
             ┌──────────────────────────────┐
             │ Dashboard JSON API + SSR panel│
             └──────────────────────────────┘
```

**Fast-ack front door.** `POST /v1/events` does the absolute minimum on the request
path — authenticate, shallow-parse the batch, stamp the server-derived `game_id` and
`provenance` onto each envelope, enqueue opaque to the queue, and ack `200 {received}`.
No per-event validation, DB write, or PII scrub happens synchronously; that's all
worker-side. The ack is a queue-acceptance receipt, not a validation promise.

**Trust boundary.** `game_id` and `provenance` come from the credential class the
request authenticated with (public `pk_…` client key → `provenance = client`; secret
`sk_…` server credential → `provenance = server`), **never** from the request body.
Only `provenance = server` events are eligible to become revenue.

**Processing.** Workers pull batches, validate per-event, and run an ordered
"flush engine" that resolves each event's identity into the durable **user spine**
and updates the result rollups. Backpressure sheds (`503`/`429` + `Retry-After`) at a
Redis-memory / queue-depth watermark so the counting path stays alive under load —
nothing that was acked is ever dropped.

Bounded contexts (NestJS modules under `src/`):

| Module | Responsibility |
|---|---|
| `ingest` | The fast-ack HTTP front door + backpressure shedding. |
| `queue` / `workers` | BullMQ wiring + the kind-dispatch kernel and flush engine. |
| `sessions` | Sessions + retention (D1/D7/D30) off the durable user spine. |
| `economy` | Sink/source currency flows, balance snapshots, supply drift. |
| `monetization` | Verified-purchase revenue, segmented monetization, payer/derived KPIs. |
| `cold-storage` | Nightly raw day-file seal → upload to S3/MinIO → verify → local delete. |
| `gdpr` | Art.17 erasure + Art.15 DSAR across the spine family. |
| `security` | Envelope encryption, credential hashing, subject-ref keying. |
| `dashboard` | Read-model JSON API consumed by the panel and external tools. |
| `panel` / `operator` | Server-rendered operator UI + the admin control-plane API. |

---

## What it measures

| Metric family | Status | Notes |
|---|---|---|
| Raw / generic events | ✅ | Canonical envelopes; kept as cold backup, not in Postgres. |
| Sessions | ✅ | Client-anchored; inactivity-timeout boundaries. |
| Retention | ✅ | D1 / D7 / D30 off the durable user spine bitmap. |
| Economy (sink / source) | ✅ | Currency flows, balance snapshots, supply drift/trend. |
| Monetization (revenue) | ✅ | Verified purchases only; server-provenance. |
| Segmented monetization | ✅ | Joined to client purchase-context via `purchase_attempt_id`. |
| Derived KPIs | ✅ | Active users, revenue, whales, first-conversion, composition. |
| Funnels | ⏳ | Design-only, deferred past v1. |

---

## Quick start

Requirements: Docker + Docker Compose, and Node 20+ if you want to run outside
containers.

```bash
git clone <this-repo> analytics-platform
cd analytics-platform

# Bring up app + Postgres + Redis + MinIO — one command, no certs needed for dev.
docker compose up
```

The app listens on **http://localhost:3000**. MinIO's console is on
**http://localhost:9001** (`minioadmin` / `minioadmin`).

Check health:

```bash
curl http://localhost:3000/health
```

For a TLS-terminated production deploy, opt into the extra profiles:

```bash
docker compose --profile proxy --profile backup up -d
```

`--profile proxy` starts Caddy (auto-TLS) in front of the app; `--profile backup`
runs the PITR (point-in-time-recovery) sidecar. Set a real `SECRET_MASTER_KEY` first
(see [Security posture](#security-posture)) — the app **refuses to boot in
production** with an empty or dev master key.

---

## Instrumenting a game

Two SDKs live in `packages/` and are published to npm independently of the platform,
as `@tusi-game/analytics-sdk` (client) and `@tusi-game/analytics-sdk-server` (server).
The on-the-wire `sdk.name` (`analytics-sdk` / `analytics-sdk-server`) is stable
regardless of the npm scope.

### Client SDK (browser / game code)

Authenticates with a **public** `pk_…` key that is safe to ship inside a build. Every
event is server-stamped `provenance = client` and can never become revenue.

```ts
import { AnalyticsClient } from '@tusi-game/analytics-sdk';

const sdk = await AnalyticsClient.init({
  sdkKey: 'pk_live_xxx',                 // PUBLIC key — safe in a game build
  endpoint: 'https://analytics.example.com',
});

await sdk.track('level_start', { level: 1 });
sdk.identify('user-123');                // anon → known on first login
```

It buffers offline, survives killed tabs (`sendBeacon` on unload), retries with
jittered backoff, dedups via stable `event_id`s, and **never throws into game code**.

### Server SDK (your trusted backend)

Authenticates with a **secret** `sk_…` credential — never ship it in a build. This is
the only path that can emit revenue.

```ts
import { AnalyticsServer } from '@tusi-game/analytics-sdk-server';

const analytics = AnalyticsServer.init({
  serverCredential: process.env.ANALYTICS_SERVER_CREDENTIAL!, // never inline
  endpoint: 'https://analytics.example.com',
});

// ...after YOUR OWN receipt validation with Apple / Google...
analytics.verifiedPurchase({
  userId: 'u-123',
  transactionId: 'txn_abc',            // store money-dedup key
  productId: 'gem_bundle_large',
  priceLocal: 4.99,
  currency: 'USD',
  verified: true,                      // outcome of YOUR validation
  environment: 'prod',
  purchaseAttemptId: attemptIdFromClient, // optional, for segmentation
});
```

The SDK never validates receipts itself — your backend passes the *outcome*. A
durable `transaction_id` gate dedups re-emitted purchases, so re-emitting on crash
recovery never double-counts, and **money is never silently dropped**.

**Segmented purchases.** The client mints a `purchase_attempt_id`, threads it into the
store call (StoreKit 2 `appAccountToken` / Google Play `obfuscatedAccountId`) and into
a zero-money purchase companion; your backend relays the same id onto
`verifiedPurchase`. This joins the authoritative revenue row to client-side context
(player level, in-game state). If you can't relay it, the purchase still counts — only
the segmented dimensions are lost.

See [`packages/sdk-client/README.md`](packages/sdk-client/README.md) and
[`packages/sdk-server/README.md`](packages/sdk-server/README.md) for the full API,
config knobs, and reliability contract.

---

## HTTP surface

**Ingest** (SDK-facing, bearer-authenticated):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/events` | Enqueue a batch of event envelopes; fast-ack `200 {received, batch_id}`. |
| `GET` | `/health` | Boot/liveness + configuration report (e.g. master-key status). |

**Dashboard read-model** (`/v1/dashboard/:gameId/…`, JSON) — consumed by the panel and
usable by external tools. Highlights:

- `counts`, `sessions`, `sessions/window`
- `retention/headline`, `retention/heatmap`
- `economy`, `economy/currencies`, `economy/supply`, `economy/supply/trend`
- `monetization/top`, `monetization/coverage`
- `kpis/active`, `kpis/revenue`, `kpis/whale`, `kpis/first-conversion`, `kpis/composition`
- `cold-storage/status`, `cold-storage/uploads`

---

## Storage model

| Store | Holds | Lifetime |
|---|---|---|
| **Redis** | Transient BullMQ queue + hot counters | ≤ 1 day |
| **Postgres** | Durable user spine + result rollups (KPIs) | Long-term |
| **Raw day-files** | Gzipped write-ahead raw events | Until sealed & shipped |
| **S3 / MinIO** | Cold backup of shipped day-files | Retention window |

**Postgres never stores raw event logs** — only the identity spine and the computed
result rollups. Raw events are written ahead to a daily gzip file (on a volume
deliberately separate from the Redis AOF disk so fsyncs don't contend), sealed nightly,
uploaded to S3-compatible storage, verified, recorded, and then **deleted locally**.

---

## Operator panel & admin API

A server-rendered panel (NestJS + Nunjucks templates, progressively enhanced with
htmx / Alpine.js, Chart.js for graphs — single process, no separate front-end build to
deploy) plus a JSON admin control-plane.

**Panel (SSR, `/panel/…`):**

- `login`, `mfa` setup
- `:gameId` dashboard, plus per-metric views: `sessions`, `retention`, `economy`, `monetization`
- `:gameId/config` — game configuration & audit
- `:gameId/ops/cold-storage`, `ops/exceptions`, `ops/erasure`
- `operators` — operator account management

**Admin API (`/admin/…`):**

- `auth/login`, `auth/logout`, `auth/me`, `auth/mfa/enrol` — operator auth with MFA + lockout
- `games` — register games, list; issue/revoke `sdk-keys` and `server-credentials`; `retire` a game
- `games/:gameId/config`, `.../config/audit` — configuration inventory + audit trail
- `games/:gameId/results/counts` — read-model access
- `games/:gameId/gdpr/erasure`, `.../gdpr/dsar`, `.../gdpr/awaiting-seal` — privacy operations
- `secrets/rotate-master-key` — master-key rotation

Operator accounts support auth, MFA/TOTP, lockout, and RBAC.

---

## Privacy & GDPR

- **Art.17 (right to erasure)** — deletes a subject across the spine family:
  `USER_SPINE`, `BALANCE_SNAPSHOT`, `PAYER_*`, `PURCHASE_IDEMPOTENCY`.
- **Art.15 (DSAR / data access)** — assembles the subject's retained data.
- Erasure is tracked in a per-game **erasure ledger** keyed by a hashed `subject_ref`
  (keyed with `SECRET_MASTER_KEY` so it isn't re-derivable from a DB dump).

Because rollups are aggregate and raw events are short-lived cold files, the surface
for personal data is deliberately small. See
[`docs/gdpr-erasure-dsar.md`](docs/gdpr-erasure-dsar.md).

---

## Security posture

- **`SECRET_MASTER_KEY`** is the out-of-DB master key for envelope-encryption of
  reversible secrets and for the erasure-ledger `subject_ref` hash. It **must** be set
  in production (env / Docker secret / file mount). The app **fails fast at boot** if
  it's empty or the insecure dev default — a DB dump then yields only ciphertext and
  non-re-derivable hashes.
- **Credentials are prefix-typed.** Public client keys (`pk_…`) and secret server
  credentials (`sk_…`) are distinguished by prefix; a config that hands a client key
  where a server credential is expected fails fast rather than silently downgrading.
- **Server credentials & SDK keys are one-way hashed** server-side (shown once on
  issue). Server-credential rotation is dual-active for zero-downtime migration.
- **TLS.** With the `proxy` profile, Caddy terminates TLS; set `REQUIRE_TLS=true` so
  the ingest guard refuses bearer auth over plain HTTP.
- **Encrypted backups.** The PITR sidecar encrypts backups with `SECRET_MASTER_KEY`
  (held outside Postgres) and refuses to run without it.

---

## Deployment

Designed for a **single VPS** in restricted or air-gapped networks.

- **Single command.** The default `docker compose up` brings up app + Redis + Postgres
  + MinIO with no certs; `--profile proxy` and `--profile backup` add TLS and PITR.
- **Digest-pinned, offline-friendly images.** All images are pinned by `sha256` digest
  for reproducible installs; see [`docs/docker-offline.md`](docs/docker-offline.md) for
  the `docker save`/`load` air-gap procedure.
- **Slewing NTP is a hard host requirement.** Containers inherit the host clock, and
  skew-correction assumes it never jumps backward. Run a *slewing* time daemon
  (`chronyd` with a bounded `maxslewrate`), never a stepping one. See
  [`docs/deployment-requirements.md`](docs/deployment-requirements.md).
- **Redis `maxmemory`.** Set with `noeviction`; the app's memory watermark must match
  so the front door sheds (`503`) before OOM. Lower both together on a smaller VPS.
- **Backups & restore.** PITR (`pg_basebackup` + WAL archiving to MinIO) via
  `scripts/pitr-*.sh`; see [`docs/backup-restore.md`](docs/backup-restore.md).

More: [`docs/reverse-proxy.md`](docs/reverse-proxy.md),
[`docs/redis-memory-budget.md`](docs/redis-memory-budget.md).

---

## Development

```bash
npm install                 # workspaces: root app + packages/*

npm run dev                 # NestJS watch mode (expects Redis/Postgres/MinIO up)
npm run build               # tailwind CSS + nest build → dist/
npm start                   # run the built app

npm test                    # unit tests (Jest)
npm run test:e2e            # end-to-end tests
npm run test:cov            # coverage

npm run lint                # eslint (0 warnings)
npm run format              # prettier --write

npm run migration:run       # TypeORM migrations (also :revert, :generate, :show)
npm run seed                # seed data

npm run sdk:build           # build both SDK packages (packages/*)
npm run sdk:test            # test both SDK packages
npm run changeset           # record a release note for the SDKs (changesets)
```

You typically run the datastores in Docker and the app on the host, or use
`Dockerfile.dev` (hot-reload) via `docker compose up`.

SDK releases are cut with [changesets](https://github.com/changesets/changesets) and
published to npm via OIDC trusted publishing (no `NPM_TOKEN`) — see
[`docs/npm-publishing.md`](docs/npm-publishing.md).

The project follows **[GitHub Spec Kit](https://github.com/github/spec-kit)**
conventions — every feature has a spec, plan, and task list under `specs/` before it's
implemented.

---

## Project layout

```
src/                    NestJS app (bounded-context modules — see Architecture)
packages/
  sdk-client/           browser/game client SDK (@tusi-game/analytics-sdk, MIT)
  sdk-server/           Node server SDK (@tusi-game/analytics-sdk-server, MIT)
specs/                  Spec Kit specs/plans/tasks (000-scaffold … 012-panel)
docs/                   deployment, offline docker, backup/restore, GDPR, redis budget
deploy/                 Caddyfile (reverse proxy / TLS)
scripts/                pitr-backup.sh / pitr-restore.sh
docker-compose.yml      app + postgres + redis + minio (+ proxy/backup profiles)
```

The `specs/` tree is the source of truth for *why* each subsystem is shaped the way it
is — start at
[`specs/001-analytics-platform/spec.md`](specs/001-analytics-platform/spec.md) and the
per-story specs `002-foundation-ingest` … `012-panel`.

---

## Roadmap

- Funnels (design-only in v1).
- First npm publish of the SDKs — the release pipeline (changesets + OIDC trusted
  publishing) is wired up; it needs the `@tusi-game` npm org + a trusted publisher
  configured once. See [`docs/npm-publishing.md`](docs/npm-publishing.md).
- Segmented retention (platform-wide only in v1).

---

## License

The **platform** (this repository — ingest, workers, dashboard, panel) is licensed
under **Apache-2.0**. The **SDK packages** in `packages/` are **MIT** (per-package),
so they can be embedded inside third-party game builds; see the `LICENSE` file in each
package directory.
