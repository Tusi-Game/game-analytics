# Game Analytics Platform

A lightweight, **self-hostable, multi-game** analytics platform — built because GameAnalytics and Google Analytics are unusable under sanctions / network restrictions. One install serves many Phaser.js / React games (with NestJS backends). Leans on Redis + a queue for processing, stores only **processed results** in Postgres (never raw logs), and keeps disposable daily raw-event files as cold backup (→ S3 → deleted locally).

## Status

Spec-driven (using [GitHub Spec Kit](https://github.com/github/spec-kit) conventions). Currently in the **specify** phase.

## Spec Kit workflow

| Phase | Command | Artifact | State |
|---|---|---|---|
| Constitution | `/speckit.constitution` | `.specify/memory/constitution.md` | todo |
| Specify | `/speckit.specify` | `specs/001-analytics-platform/spec.md` | ✅ draft |
| Research | (supports specify) | `specs/001-analytics-platform/research.md` | ✅ survey + domain done; open clarifications pending |
| Plan | `/speckit.plan` | `specs/001-analytics-platform/plan.md` | todo |
| Tasks | `/speckit.tasks` | `specs/001-analytics-platform/tasks.md` | todo |
| Implement | `/speckit.implement` | source code | todo |

## Read next

1. [`specs/001-analytics-platform/spec.md`](specs/001-analytics-platform/spec.md) — the requirement: user stories, functional requirements, success criteria, decided clarifications.
2. [`specs/001-analytics-platform/research.md`](specs/001-analytics-platform/research.md) — adopt-vs-build survey, game-analytics domain knowledge, and the 6 open research tasks to close before planning.

## Decided so far (v1)

- **Metrics**: raw events, sink/source economy, retention (D1/D7/D30), segmented monetization. Funnels are design-only (deferred).
- **Stack**: NestJS + TypeScript (ingest API, workers, dashboard API); Next.js dashboard; Docker Compose.
- **Storage**: Redis = transient queue + hot counters (≤1 day). Postgres = user spine + result rollups only. Daily gzip raw files → S3-compatible → deleted local.
- **Identity**: game-provided stable `user_id` + SDK anon id for pre-login.
- **SDKs**: browser/JS client SDK + Node/NestJS server SDK.
