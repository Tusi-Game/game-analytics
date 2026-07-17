# Operator / Admin Control Plane

**Part of:** [001-analytics-platform](../001-analytics-platform/spec.md)
**Status:** Draft (2026-07-17) · story design (operational control plane)
**Depends on:** [002-foundation-ingest](../002-foundation-ingest/spec.md) (owns the `GAME` registry + `GAME.config` blob this story is the human write-path into), [004-economy](../004-economy/spec.md) & [006-monetization](../006-monetization/spec.md) (read `CONFIG_AUDIT.effective_from` for their dimension-era / FX-era coverage caveats). Shared substrate: [foundation.md](../001-analytics-platform/foundation.md) §1.2/§4.5/§5, [ops-envelope.md](../001-analytics-platform/ops-envelope.md) (rate-limit + erasure knobs, §7 erasure, §9 secret-encryption/MFA/DSAR-access).

**Grounding:** Foundation §1.2 (`GAME` registry, `GAME.config`), §4.5 (credential classes — F-3 resolved, 2026-07-17), §5 (ownership; ingest/foundation owns the registry), §8 conventions; every metric story's `§6 Configurations`; [`ops-envelope.md`](../001-analytics-platform/ops-envelope.md) (rate-limit + erasure knobs); [`research.md` §7](../001-analytics-platform/research.md) Q2 (key classes), Q7 (erasure). Consumed by: the NestJS Panel (see [012-panel](../012-panel/spec.md)) and the dashboard API (NestJS).

**Altitude:** logical model + control-plane behavior — entities, the config-effective-time rule, the admin surface inventory. **No auth-library choice, no UI code, no DDL.**

> The `## Design` section for this story lives in [design.md](./design.md).

---

## 1. Story understanding

Every other story assumes an operator who registered a game, holds its keys, and turns its knobs. This story is that operator's surface: **how a human administers the platform**. It answers three questions no metric story owns — *who may log in and change things* (operator accounts), *how a game gets its keys and rotates them* (registration + credential lifecycle, the Q2 two-class model made operational), and *how a config change takes effect* (the forward-only effective-time rule that keeps sealed results immutable).

The platform is **self-hosted, single-tenant** in the deployment sense — one studio runs one instance for its own games. So "auth" here is operator-account auth for the studio's staff, not per-end-user auth (end users are the game's players; the platform never authenticates *them*). "Multi-tenant" inside the instance means **multiple games under one operator**, each with isolated keys, config, and data (FR-001) — never multiple mutually-distrusting customers.

Everything this story adds is **operational, not per-player**: new entities (`OPERATOR_ACCOUNT`, `CONFIG_AUDIT`, and the credential children of `GAME`) attach to the foundation model as registry/operational tables. **The per-user spine rules (Foundation §1.3) are untouched** — nothing here keys on `user_id`.

## 2. How it works — the admin surface

Three surfaces, all served by the dashboard API (Foundation §5 path "direct" — registry reads/writes go straight to Postgres, never through the flush):

1. **Operator authentication** — operator accounts log into the dashboard; a session grants read of every game's results and write of every game's config + credentials.
2. **Game lifecycle** — register a game → receive its `sdk_key`; create/rotate/revoke `server_credential`s; retire a game.
3. **Config administration** — a UI + API over every `§6` knob across the metric stories (plus the ops-envelope knobs), each change written **forward-only** and recorded in an audit trail.

## 3. Data needed (input)

This story consumes **no event envelope** — it adds no ingest field and no `kind`. Its inputs are operator actions on the control plane:
- operator credentials (login);
- a game name at registration;
- credential create/rotate/revoke commands;
- a `(game_id, config_key, new_value)` tuple per config change.

## 4. Data stored for longer-run processing

Operational registry/audit state only — see [design.md](./design.md) §ER. None of it is a metric result or a per-user draw; all of it is small (per-game or per-operator cardinality) and direct-write.

## 5. Data-structure thinking — Redis & database

- **Postgres** holds every entity this story owns (`OPERATOR_ACCOUNT`, `GAME_SDK_KEY`, `GAME_SERVER_CREDENTIAL`, `CONFIG_AUDIT`) plus the existing `GAME` registry it extends. All direct-write (Foundation §5).
- **Redis** holds only what already exists for the hot path: the **worker config cache** is a small per-game snapshot of `GAME.config` that ingest/flush workers read so they don't hit Postgres per event. Losing it just forces a reload — it is transient-and-losable (Foundation §6). No admin-owned durable Redis state.

## 6. Configurations

This story's own knobs are minimal (it *administers* the others):
- `operator_session_timeout_min` — idle logout for the admin session (default 120, mirroring npm's 2-hour session norm; SDK-independent).
- `worker_config_cache_refresh_sec` — how often workers re-read the per-game config snapshot (default 30; the upper bound on config-change latency — [design.md](./design.md) §effective-time).
- `operator_login_max_attempts` / `operator_lockout_min` — brute-force lockout (default 5 attempts → 15 min backoff).
- `operator_mfa_required` — require TOTP MFA at login (default off; strongly recommended on — self-hostable, no external dependency).

Both are platform-level (not per-game). Every *other* knob in the system is inventoried and administered here but **owned by its story** — this story never redefines a knob's semantics, only surfaces it.
