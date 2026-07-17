# Phase 10 — Operator / Admin Surface

**Feature**: 001-analytics-platform · **Layer**: story design (operational control plane) · **Status**: Draft (2026-07-17)
**Grounding**: Foundation §1.2 (`GAME` registry, `GAME.config`), §4.5 (credential classes — F-3 resolved, 2026-07-17), §5 (ownership; 01 owns the registry), §8 conventions; every phase 01–07 `§6 Configurations`; [`00.5-ops-envelope.md`](00.5-ops-envelope.md) (rate-limit + erasure knobs); [`research.md` §7](../research.md) Q2 (key classes), Q7 (erasure). Consumed by: the NestJS Panel (see Phase 11) and the dashboard API (NestJS).
**Altitude**: logical model + control-plane behavior — entities, the config-effective-time rule, the admin surface inventory. **No auth-library choice, no UI code, no DDL.**

---

## 1. Story understanding

Every other phase assumes an operator who registered a game, holds its keys, and turns its knobs. This story is that operator's surface: **how a human administers the platform**. It answers three questions no metric phase owns — *who may log in and change things* (operator accounts), *how a game gets its keys and rotates them* (registration + credential lifecycle, the Q2 two-class model made operational), and *how a config change takes effect* (the forward-only effective-time rule that keeps sealed results immutable).

The platform is **self-hosted, single-tenant** in the deployment sense — one studio runs one instance for its own games. So "auth" here is operator-account auth for the studio's staff, not per-end-user auth (end users are the game's players; the platform never authenticates *them*). "Multi-tenant" inside the instance means **multiple games under one operator**, each with isolated keys, config, and data (FR-001) — never multiple mutually-distrusting customers.

Everything this story adds is **operational, not per-player**: new entities (`OPERATOR_ACCOUNT`, `CONFIG_AUDIT`, and the credential children of `GAME`) attach to the foundation model as registry/operational tables. **The per-user spine rules (Foundation §1.3) are untouched** — nothing here keys on `user_id`.

## 2. How it works — the admin surface

Three surfaces, all served by the dashboard API (Foundation §5 path "direct" — registry reads/writes go straight to Postgres, never through the flush):

1. **Operator authentication** — operator accounts log into the dashboard; a session grants read of every game's results and write of every game's config + credentials.
2. **Game lifecycle** — register a game → receive its `sdk_key`; create/rotate/revoke `server_credential`s; retire a game.
3. **Config administration** — a UI + API over every `§6` knob across phases 01–07 (plus the phase-00.5 knobs), each change written **forward-only** and recorded in an audit trail.

## 3. Data needed (input)

This story consumes **no event envelope** — it adds no ingest field and no `kind`. Its inputs are operator actions on the control plane:
- operator credentials (login);
- a game name at registration;
- credential create/rotate/revoke commands;
- a `(game_id, config_key, new_value)` tuple per config change.

## 4. Data stored for longer-run processing

Operational registry/audit state only — see §Design ER. None of it is a metric result or a per-user draw; all of it is small (per-game or per-operator cardinality) and direct-write.

## 5. Data-structure thinking — Redis & database

- **Postgres** holds every entity this story owns (`OPERATOR_ACCOUNT`, `GAME_SDK_KEY`, `GAME_SERVER_CREDENTIAL`, `CONFIG_AUDIT`) plus the existing `GAME` registry it extends. All direct-write (Foundation §5).
- **Redis** holds only what already exists for the hot path: the **worker config cache** (below) is a small per-game snapshot of `GAME.config` that ingest/flush workers read so they don't hit Postgres per event. Losing it just forces a reload — it is transient-and-losable (Foundation §6). No admin-owned durable Redis state.

## 6. Configurations

This story's own knobs are minimal (it *administers* the others):
- `operator_session_timeout_min` — idle logout for the admin session (default 120, mirroring npm's 2-hour session norm; SDK-independent).
- `worker_config_cache_refresh_sec` — how often workers re-read the per-game config snapshot (default 30; the upper bound on config-change latency — §Design effective-time).
- `operator_login_max_attempts` / `operator_lockout_min` — brute-force lockout (default 5 attempts → 15 min backoff).
- `operator_mfa_required` — require TOTP MFA at login (default off; strongly recommended on — self-hostable, no external dependency).

Both are platform-level (not per-game). Every *other* knob in the system is inventoried and administered here but **owned by its phase** — this story never redefines a knob's semantics, only surfaces it.

---

## Design

*Per Foundation §8.3. Adds three operational entities + the config-effective-time rule; touches no spine tier and no metric result. Cites "Foundation §N".*

### ER / data model

**Owned operational entities (all Postgres, direct-write, registry-scope):**

| Entity | Key | Non-key attributes | Cardinality | Notes |
|---|---|---|---|---|
| `OPERATOR_ACCOUNT` | `operator_id` | `email`, `password_hash` (or external-IdP subject), `mfa_totp_secret` (encrypted, if MFA on), `failed_login_count` + `locked_until` (lockout), `role` (`admin` \| `viewer` v1, **enforced** — viewer cannot write config/credentials), `created_at`, `disabled_at` | operator-staff count (tiny) | self-hosted single-tenant: these are the studio's staff, not players. One over-privileged account guards all games + infra secrets, so it is hardened (§ Account security) |
| `GAME_SDK_KEY` | `game_id` FK, `key_id` | `key_prefix` (public, viewable), `key_hash`, `created_at`, `last_used_at`, `revoked_at` | ≥ 1 active per game (rotation of shipped builds needs ≥ 2 briefly) | the public client key (Q2); auto-issued at registration; **viewable in admin** because it is public by design |
| `GAME_SERVER_CREDENTIAL` | `game_id` FK, `credential_id` | `credential_prefix`, `credential_hash`, `created_at`, `last_used_at`, `revoked_at` | **1..N** active per game | the secret server credential (Q2); **created on demand, shown once, stored hashed**; realizes Foundation §1.2's `GAME.server_credential` as a 1..N child |
| `CONFIG_AUDIT` | `game_id` FK, `audit_id` | `operator_id` FK, `config_key`, `old_value`, `new_value`, `changed_at`, `effective_from` (processing-time watermark) | one row per config change (append-only) | the forward-only change trail; `effective_from` is what the read model uses to explain a dimension-era boundary |

```mermaid
erDiagram
    GAME ||--o{ GAME_SDK_KEY : "issues (>=1, public)"
    GAME ||--o{ GAME_SERVER_CREDENTIAL : "issues (1..N, secret)"
    GAME ||--o{ CONFIG_AUDIT : "records changes to config"
    OPERATOR_ACCOUNT ||--o{ CONFIG_AUDIT : "made by"
    GAME {
        id   game_id PK
        text name
        json config "the knobs administered here; owned per-phase"
    }
    OPERATOR_ACCOUNT {
        id   operator_id PK
        text email
        text password_hash "or external-IdP subject"
        text role "admin|viewer"
    }
    GAME_SDK_KEY {
        id   game_id PK, FK
        id   key_id PK
        text key_prefix "public, viewable"
        text key_hash
        ts   last_used_at
        ts   revoked_at
    }
    GAME_SERVER_CREDENTIAL {
        id   game_id PK, FK
        id   credential_id PK
        text credential_prefix
        text credential_hash "show-once; hashed at rest"
        ts   last_used_at
        ts   revoked_at
    }
    CONFIG_AUDIT {
        id   game_id PK, FK
        id   audit_id PK
        id   operator_id FK
        text config_key
        text old_value
        text new_value
        ts   effective_from "processing-time watermark"
    }
```

The `sdk_key` / `server_credential` scalars in Foundation §1.2's `GAME` sketch are **read as these 1..N children** (the F-3 resolution flagged exactly this). Ownership is unchanged — 01 owns the `GAME` registry (Foundation §5); this story's admin API is the write path into it and its credential/audit children.

### Credential lifecycle (Q2 made operational)

Realizes Foundation §4.5's two credential classes as concrete admin flows. **Prefix-typed strings** (class recognizable on sight and by secret scanners); an SDK fails fast on a wrong-class key at init.

| Flow | Behavior |
|---|---|
| **Registration** | create `GAME` → **auto-issue one `GAME_SDK_KEY`** (public; shown and thereafter viewable). A `server_credential` is **not** auto-issued — server-scope is created explicitly on demand (matches the "optional" §1.2 note). |
| **Create server credential** | generate → **display exactly once** → persist only `credential_hash` + `credential_prefix` + `created_at`. Never retrievable again; lost ⇒ create a new one and revoke the old. |
| **Rotation (server)** | **dual-active**: create new → deploy to the game's backend → watch `last_used_at` on the old credential drain → revoke (immediate) or schedule a Stripe-style grace expiry. Multiple credentials live simultaneously by design. |
| **Rotation (client `sdk_key`)** | also supports ≥ 2 active, because **shipped builds can never be updated** — a new key ships in the next build while the old stays valid for existing installs. Revoking an `sdk_key` is an **emergency action**: all shipped builds using it go dark at ingest (their events become drop-and-tally, Foundation §4.4). **The admin UI must state this explicitly** before allowing revoke. |
| **Auth resolution** | at ingest, the front door resolves the presented credential → its class → `provenance` stamp (Foundation §4.5). Unrecognized or revoked ⇒ **auth fails outright**; the fallback-`client` rule (Foundation §9.5) applies only to a valid-but-unclassifiable legacy edge, never to a bad credential. |
| **Retire a game** | disable ingest (all keys revoked) while keeping results + raw lifecycle intact; the game's data is not deleted by retirement (erasure is the separate per-user Q7 flow, 00.5). |

Out of v1 (flagged, precedented): per-environment (sandbox/live) key pairs, per-platform client keys, Stripe-style restricted server scopes, IP allowlists, optional HMAC body-signing as anti-abuse hardening — none alter the two-class model.

### Account security (hardening — 2026-07-17)

One operator account gates read of every game's data **and** write of every game's config + credentials **and** (via config) the infra secrets. Session-timeout alone is far below baseline for that privilege, so v1 adds: **login rate-limit + lockout** (`operator_login_max_attempts` / `operator_lockout_min`); **optional TOTP MFA** (`operator_mfa_required` — self-hostable, no external dependency, works under sanctions); **failed-login auditing** (a distinct audit stream from `CONFIG_AUDIT`); and an **enforced `viewer`/`admin` split** (the roles existed in the ER but enforcement was unspecified — a `viewer` session can read results but cannot write config or touch credentials). The admin panel is served behind the reverse proxy and may be IP-allowlisted for the solo operator.

### Infra-secret storage + rotation (hardening — 2026-07-17)

Reversible infra secrets — `cold_storage_credentials` (S3 write keys), `fx_table` API material, the per-game `ERASURE_LEDGER` hash key, and any `mfa_totp_secret` — are **never stored plaintext in `GAME.config`**. They are envelope-encrypted with a **master key held outside Postgres** (env var / Docker secret / file mount), decrypted only in-worker (Foundation §1.2, 00.5 §9). A DB dump then yields ciphertext, not the operator's object-store keys — and the erasure-ledger key living outside the DB is what keeps the keyed hash lawful pseudonymization (00.5 §7.5 / §9). The admin surface adds an **infra-secret rotation path** (the existing credential-rotation flow covers game keys, not S3/FX secrets): re-encrypt under a new master key, or replace an S3 key and re-encrypt.

### Right-of-access (DSAR / GDPR Art. 15 + Art. 20) — the symmetric surface

The erasure trigger has a **read-only sibling**: an operator-verified **DSAR-access request** (same verification path as erasure) invokes the 00.5 §9 access job, which assembles a machine-readable export of the subject's spine family (`active_days_bitmap`, `PAYER_SPINE_EXT`, `PAYER_PERIOD_SPEND`, `PURCHASE_IDEMPOTENCY`, `IDENTITY_EDGE` if any) with the Art. 11 boundary documented (aggregate cells that no longer identify the subject are out of scope, and the export says so). Hosted here beside the erasure request surface; no new per-user durable state.

### Config administration + the effective-time rule

**The admin API/UI covers every `§6` knob across the system.** Inventory (owner phase in parens — this story surfaces, never redefines):

| Knob | Owner | Effect timing |
|---|---|---|
| `event_name_cap_per_game`, `property_key_cap_per_event`, `top_n_events`, `pii_prop_denylist` (default-DENY), `pii_prop_value_scrubber`, `pii_prop_hash` | 01 | caps forward-only; `top_n_events` retroactive; PII denylist ships a **non-empty default** + value scrubber (00.5 §9) |
| `economy_ratio_min_events` | 03 | display-only sink-ratio low-volume guard |
| `operator_login_max_attempts`, `operator_lockout_min`, `operator_mfa_required`, `operator_session_timeout_min` | 10 | account hardening (§ Account security); platform-level |
| `session_inactivity_timeout_min`, `session_max_duration_cap_min`, `session_min_duration_ms` | 02 | forward-only (never re-buckets emitted sessions) |
| `economy_currency_allowlist`, `economy_depth_capture_mode`, `economy_top_n_reasons`, `level_bucket_boundaries` | 03 | allowlist/boundaries/depth forward-only; `economy_top_n_reasons` retroactive |
| `retention_day_targets`, `retention_min_cohort_size` | 04 | targets forward-only (bitmap-horizon widening annotated "tracking begins …"); min-cohort-size is a display-only sample-size mask |
| `reporting_offset` (**platform-level**, Foundation §4.7) | 00/platform | **correctness-bearing, set-once at install** — defines the platform logical day for **all** metrics + seals (single timezone; no per-game/multi-timezone in v1). Changing it after data exists is a forward-rebuild, out of v1 scope. Set to the operator's zone (e.g. Asia/Tehran +3:30) at install. |
| `monetization_dimensions`, `payer_tier_rule`, `fx_table`, `fx_staleness_max_days`, `monetization_dimension_value_cap` | 05 | `monetization_dimensions` + `…_value_cap` rebuild-forward; `fx_table`/`fx_staleness_max_days` affect unsealed re-normalization only; `payer_tier_rule` re-tiers **future reads** at zero migration (spine stores spend, not tier — Q3) |
| `mau_window_days`, `whale_min_payers` | 06 | read-time windows — retroactive (recomputed at read) |
| `cold_storage_enabled`, `cold_storage_bucket`, `cold_storage_credentials`, `cold_storage_local_retention_days`, `cold_storage_upload_schedule`, `raw_file_compression` | 07 | all forward-only (toggle/codec never rewrite existing files) |
| `raw_retention_days`, `erasure_purchase_mode`, `strict_raw_rewrite` | 00.5 (Q7) | retention forward-only; erasure-mode governs future erasure jobs |
| `ingest_events_per_sec_cap` | 00.5 | forward-only per-game ingest cap (protects tenants from a flooding neighbor; breach → 429 + `rate_limited` tally) |
| `operator_session_timeout_min`, `worker_config_cache_refresh_sec` | 10 | platform-level; take effect on next session / next cache refresh |

**Config-effective-time semantics — "forward-only, pinned to processing time" (normative).** A config change applies to events **processed after the change is visible to the workers** — never retroactively to already-processed events, and never to sealed results.

- The change is written to `GAME.config` + a `CONFIG_AUDIT` row stamped `effective_from` = the processing-time watermark at which workers begin honoring it.
- **Worker config-cache refresh:** ingest/flush workers read a per-game config snapshot from Redis (the worker config cache), refreshed every `worker_config_cache_refresh_sec` (default 30). So the realized effective-time is "within one refresh interval of the admin write" — a bounded, documented lag, not instantaneous. The audit row's `effective_from` records the watermark, so a later dimension-era or FX-era boundary is explainable from the trail (05's "dimension-era caveat" reads this).
- **This rule is why every rebuild-forward knob is safe:** a `monetization_dimensions` change re-keys only cells written after `effective_from`; sealed cells keep their old encoding; the read model reports per-period coverage rather than faking continuity. `payer_tier_rule` is the one knob whose *thresholds* re-tier future reads immediately (the spine stores raw spend), but even it never restamps a sealed display cell's `payer_tier` dimension.
- **Display-only knobs are exempt from re-bucketing** by construction: `per_game_reporting_timezone_offset` shifts presentation, never stored aggregates (research §G-2/§G-3); internal math stays UTC.

### API / contract surface

- **No SDK contract** — this story adds no envelope field, endpoint, or `kind`; the SDKs never see the admin surface.
- **Admin API (dashboard API, PG-direct), operator-authenticated:** operator login/logout; game register/list/retire; `sdk_key` view + rotate + revoke; `server_credential` create(show-once) + rotate + revoke + `last_used_at` read; config get/set per `(game_id, key)` with server-side validation of the value against the knob's contract; `CONFIG_AUDIT` list per game. Every write emits a `CONFIG_AUDIT` (config) or credential-lifecycle audit row.
- **Read model:** the admin dashboard reads registry + audit tables directly; config-era boundaries surfaced from `CONFIG_AUDIT.effective_from` feed the metric read-models' dimension/FX-era caveats. No Redis merge (operational metadata, not open-day results — Foundation §3.3).

### Relations with other stories

- **Owns:** `OPERATOR_ACCOUNT`, `GAME_SDK_KEY`, `GAME_SERVER_CREDENTIAL`, `CONFIG_AUDIT`; the admin API; the config-effective-time rule; the worker config-cache contract (workers *read* it).
- **Writes (shared):** `GAME` + `GAME.config` (owned by 01's registry, Foundation §5) — this story is the human write-path into them; the credential children realize Foundation §1.2's `server_credential` scalar.
- **Reads:** every phase's `§6` knob contract (to validate values); `last_used_at` telemetry the ingest front door stamps on each credential use.
- **Feeds:** the **ingest front door** (Foundation §4.5) resolves the credentials this story issues → `provenance`; **every worker** reads the config this story writes (via the cache); **05/03** read the config-era boundaries for their coverage caveats; the **erasure job (00.5, Q7)** is triggered through this admin API (operator-verified request — identity verification is the studio's duty, mirroring Matomo).
- **Ordering / lifecycle:** a game must be registered (keys issued) before any event authenticates; a config change is durable + audited before it reaches workers (bounded by the cache refresh); credential revocation takes effect at the next auth resolution; retiring a game stops ingest without deleting data (erasure is the separate per-user flow).
- **Flagged bridges:** none — this is a self-contained control plane. Its one cross-cutting dependency (credential-class → provenance) is already folded into Foundation §4.5; its erasure trigger is specified in [`00.5-ops-envelope.md`](00.5-ops-envelope.md).

### New entities acknowledged in the foundation model

`OPERATOR_ACCOUNT`, `GAME_SDK_KEY`, `GAME_SERVER_CREDENTIAL`, `CONFIG_AUDIT` are **operational registry entities**, not per-user spine draws — they attach to `GAME` (or stand alone for `OPERATOR_ACCOUNT`) and cost nothing against the SC-007 spine budget. `ER-full.md` and Foundation §1.2/§5 are updated to acknowledge them (Stage 4 reconciliation).
