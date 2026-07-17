# Game Analytics Platform

A lightweight, **self-hostable, multi-game** analytics platform — built because GameAnalytics and Google Analytics are unusable under sanctions / network restrictions. One install serves many Phaser.js / React games (with NestJS backends). Leans on Redis + a queue for processing, stores only **processed results** in Postgres (never raw logs), and keeps disposable daily raw-event files as cold backup (→ S3 → deleted locally).

## Status

Spec-driven (using [GitHub Spec Kit](https://github.com/github/spec-kit) conventions). Specify, Research, and Tasks are complete; currently in the **plan** phase (see [`specs/001-analytics-platform/plan.md`](specs/001-analytics-platform/plan.md)).

## Spec Kit workflow

| Phase | Command | Artifact | State |
|---|---|---|---|
| Constitution | `/speckit.constitution` | `.specify/memory/constitution.md` | ✅ draft |
| Specify | `/speckit.specify` | `specs/001-analytics-platform/spec.md` + per-story `specs/00X-*/spec.md` | ✅ |
| Research | (supports specify) | `specs/001-analytics-platform/research.md` | ✅ |
| Plan | `/speckit.plan` | per-story `specs/00X-*/design.md` (no umbrella `plan.md` yet) | in progress / next |
| Tasks | `/speckit.tasks` | per-story `specs/00X-*/tasks.md` | ✅ |
| Implement | `/speckit.implement` | source code | todo |

## Read next

1. [`specs/001-analytics-platform/spec.md`](specs/001-analytics-platform/spec.md) — the requirement: user stories, functional requirements, success criteria, decided clarifications.
2. [`specs/001-analytics-platform/research.md`](specs/001-analytics-platform/research.md) — adopt-vs-build survey, game-analytics domain knowledge, and the 6 open research tasks to close before planning.
3. **Per-story specs** — [`specs/002-foundation-ingest/`](specs/002-foundation-ingest/) … [`specs/012-panel/`](specs/012-panel/) — **one story per directory** (foundation/ingest, sessions, economy, retention, monetization, derived KPIs, cold storage, client/server SDKs, operator admin, panel), each carrying `spec.md` + `design.md` + `tasks.md`. Shared cross-story substrate lives at the platform level in [`specs/001-analytics-platform/foundation.md`](specs/001-analytics-platform/foundation.md).
4. **Per-metric detail** now lives inside each story's `spec.md` / `design.md` (no separate `metrics/` directory). The durable per-metric cost/spine budget is tracked in [`specs/001-analytics-platform/spine-budget-ledger.md`](specs/001-analytics-platform/spine-budget-ledger.md).

## Decided so far (v1)

- **Metrics**: raw events, sink/source economy, retention (D1/D7/D30), segmented monetization. Funnels are design-only (deferred).
- **Stack**: NestJS + TypeScript (ingest API, workers, panel); server-rendered NestJS + Nunjucks panel (single process — no separate front-end); Docker Compose.
- **Storage**: Redis = transient queue + hot counters (≤1 day). Postgres = user spine + result rollups only. Daily gzip raw files → S3-compatible → deleted local.
- **Identity**: game-provided stable `user_id` + SDK anon id for pre-login.
- **SDKs**: browser/JS client SDK + Node/NestJS server SDK.
