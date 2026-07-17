# Feature Specification: Self-Hosted Multi-Game Analytics Platform — Platform Umbrella

**Feature Branch**: `001-analytics-platform`
**Created**: 2026-07-17
**Restructured**: 2026-07-17 — the single massive spec was split into **one spec per story** (`002`–`012`, siblings of this dir). This `001` directory is now the **platform umbrella**: it holds the cross-cutting material every story shares (why-build, platform-wide requirements & success criteria, clarifications, assumptions) plus the shared substrate (`foundation.md`, `bridges/`, `ER-full.md`, `ops-envelope.md`, `research.md`, `PLAN-INDEX.md`, `funnels.md`). Each story-spec depends on and cites this umbrella; none re-derives it.
**Status**: Ready for `/plan` — **all six `[NEEDS CLARIFICATION]` resolved via research (2026-07-17)**, all 10 ratification questions (Q1–Q10) resolved by the design layer, all `research.md §6` second-order questions resolved (2026-07-17), funnels scope decision ratified as **DECLINED (design-only v1)**, spine-budget ledger reconciled against SC-007, constitution drafted. The adversarial-review hardening pass (~35 findings) is complete. Residual defers (anon↔user merge, automated rebuild tool, Redis HA, DST) are documented and non-blocking.
**Input**: Owner wants a lightweight, self-hostable analytics platform for their own Phaser.js / React games (with NestJS backends), because GameAnalytics and Google Analytics are unusable under sanctions / network restrictions. Must serve **multiple games** from one install, lean heavily on Redis + a queue for processing, store only **processed results** (not raw logs) in Postgres, and keep disposable daily raw-event files as cold backup (uploaded to S3, then deleted locally).

## Story-spec index — the split

The system is decomposed into **one spec per story**, each an independently testable, independently valuable slice living in its own sibling directory. Each carries a `spec.md` (story + calculation), a `design.md` (its logical-model realization on the shared `foundation.md`), and a `tasks.md` (or a pointer where task lists are combined). Build/reading order runs top-to-bottom.

| Story dir | Story | Priority | Owns kind | Depends on |
|---|---|---|---|---|
| [`002-foundation-ingest`](../002-foundation-ingest/spec.md) | Register a game, fire events, watch them count up (US1) | P1 | `generic` (substrate for all) | — (foundation) |
| [`003-sessions`](../003-sessions/spec.md) | The atomic engagement unit; the shared "active on a day" anchor | P2 | `session` | 002 |
| [`004-economy`](../004-economy/spec.md) | Faucets vs drains, net flow, sink ratio, currency depth (US2) | P2 | `economy` | 002 |
| [`005-retention`](../005-retention/spec.md) | D1/D7/D30 by install cohort (US3) | P2 | consumes `session` | 002, 003 |
| [`006-monetization`](../006-monetization/spec.md) | Top package by whom / when / context; server-truth revenue (US4) | P2 | `purchase` | 002 |
| [`007-derived-kpis`](../007-derived-kpis/spec.md) | DAU/WAU/MAU, stickiness, ARPU/ARPPU/ARPDAU, conversion, whale | P3 | derived | 003, 006 |
| [`008-cold-storage`](../008-cold-storage/spec.md) | Daily raw file → S3-compatible → delete local (US5) | P3 | — (ops) | 002 |
| [`009-client-sdk`](../009-client-sdk/spec.md) | The browser/game SDK — packaged client artifact (npm) | — | emits all kinds (client-provenance) | 002, 003, 004, 006 |
| [`010-server-sdk`](../010-server-sdk/spec.md) | The Node server SDK — trusted money/economy path (npm) | — | emits `purchase`/`economy` (server-provenance) | 006, 004; foundation §4.5 |
| [`011-operator-admin`](../011-operator-admin/spec.md) | Operator auth, game registration + key rotation, config admin | — | — (control plane) | 002, foundation §4.5 |
| [`012-panel`](../012-panel/spec.md) | Server-rendered analytics panel: metrics, config admin, game management, ops | — | — (presentation) | 002–011, ops-envelope |

**Reading order:** 002 (foundation) → 003 (sessions — the activeness anchor everything leans on) → 004 / 005 / 006 (the core metrics) → 007 (derived from all of the above) → 008 (operational lifecycle, read anytime after 002) → 011 (operator admin) → **012 (panel)**. For the shared design layer, read [`foundation.md`](foundation.md) first, then each story's `design.md`, then the [`bridges/`](bridges/), then [`ER-full.md`](ER-full.md).

## Platform-umbrella artifacts (this directory)

| Artifact | Purpose (one line) |
|---|---|
| [`spec.md`](spec.md) | **This file** — the platform-wide requirements, success criteria, clarifications, and the story-spec index above. |
| [`research.md`](research.md) | The adopt-vs-build survey, domain knowledge §A–§D, the locked §B–§H decisions, and the full Q1–Q10 + hardening research trail. |
| [`foundation.md`](foundation.md) | The shared design base every story `design.md` cites: global ER skeleton + spine tiers, Redis key grammar/TTLs, pipeline backbone + canonical op-ordering (the routed record), dedup/skew/seal machinery, provenance, ownership matrix, durability ledger. |
| [`bridges/`](bridges/) | The three cross-story seam contracts: `01.5-raw-file-contract.md` (ingest ↔ cold-storage), `02.5-activeness-spine-contract.md` (sessions → retention spine writes), `05.5-purchase-accept-contract.md` (monetization ↔ derived-KPIs money seam). |
| [`ER-full.md`](ER-full.md) | The assembled whole-system ER — every durable entity with keys, the ownership/write-path legend, projections-vs-truth map. |
| [`ops-envelope.md`](ops-envelope.md) | The ops envelope — scale arithmetic, Redis/queue budgets, backpressure posture, per-game rate limiting, scale-lever triggers, and the normative GDPR/CCPA erasure design (Q7). |
| [`spine-budget-ledger.md`](spine-budget-ledger.md) | The authority on total per-user/per-payer durable cost — every spine draw reconciled against SC-007, plus the funnels-DECLINED scope ruling. |
| [`PLAN-INDEX.md`](PLAN-INDEX.md) | The implementation build-order map and consolidated R1–R13 reconciliation ledger of cross-cutting flags to settle at `/plan`. |
| [`funnels.md`](funnels.md) | The **deferred** (design-only, FR-022) funnel specification — forward-compatible artifact, no story dir, no v1 work. |

The project **constitution** (P1–P13) lives at [`../../.specify/memory/constitution.md`](../../.specify/memory/constitution.md) and binds every story-spec and every `/plan` decision.

---

## Why This Is a Custom Build (Not Adopt) — Research Conclusion

A survey of self-hostable, open-source analytics tools (full findings in `research.md`) concluded that **no existing tool fits**. Summary of the disqualifiers:

| Candidate | Disqualifier |
|---|---|
| PostHog (self-host) | Requires ClickHouse + Kafka (heavy infra we avoid); 1 project per instance (no multi-tenancy); free self-host soft-capped ~100k events/mo, then pushes to PostHog Cloud (blocked under sanctions). |
| Countly Community | Funnels, retention, cohorts, segmentation are **Enterprise-only**; MongoDB not Postgres. |
| Matomo | Web-analytics paradigm; funnels + cohorts are paid plugins even self-hosted; no game economy concept. |
| Umami | Right infra shape (Postgres-only, multi-site) but no game economy, no segmented monetization, shallow funnels/retention. |
| Talo | Only maintained game-native OSS tool but ~95★, pulls in ClickHouse, no funnels/retention/revenue/economy reports. |
| GameAnalytics OSS | Client SDKs only; backend proprietary/hosted → blocked path. |

**Three requirements individually force a custom build:** (1) resource **sink/source economy** tracking (no self-hostable tool has it first-class), (2) **segmented monetization** (which package sold to whom, sliced by game context), (3) **multi-tenancy on lightweight Postgres/Redis** (no ClickHouse).

---

## User Scenarios & Testing *(mandatory)*

Each user story is an independently testable, independently valuable slice, now specified in its **own story-spec** (see the story-spec index above). Priorities: **P1** = MVP foundation, **P2** = core value, **P3** = complete-the-picture. The full story understanding, acceptance scenarios, calculation, and independent test for each live in that story's `spec.md`:

- **US1 — Register a game and start collecting events** (P1) → [`002-foundation-ingest`](../002-foundation-ingest/spec.md). Nothing else can be built or verified until multi-tenant ingestion works end-to-end.
- **US2 — Track the game economy (sink/source)** (P2) → [`004-economy`](../004-economy/spec.md). The headline feature no off-the-shelf tool provides; the primary reason to build.
- **US3 — Measure retention (D1/D7/D30)** (P2) → [`005-retention`](../005-retention/spec.md) (spine writes owned by [`003-sessions`](../003-sessions/spec.md)). A core health metric; drove the minimal-per-user-spine decision.
- **US4 — Segmented monetization analytics** (P2) → [`006-monetization`](../006-monetization/spec.md). "Top package by whom / when / context" from server-verified purchase data.
- **US5 — Cold-storage lifecycle for raw events** (P3) → [`008-cold-storage`](../008-cold-storage/spec.md). Disposable daily raw file → S3-compatible → delete local.

Supporting stories (sessions, derived KPIs, SDKs, operator admin, panel) are indexed above. The platform-wide **edge cases**, **requirements**, and **success criteria** that cut across all stories remain below — they are the umbrella contract every story-spec obeys.

**Independent Test**: Send purchases carrying context dimensions; confirm the dashboard can answer "top package by <dimension>" for the configured dimensions and that server-sent purchases are the trusted source.

**Acceptance Scenarios**:
1. **Given** a purchase event with product, price, and context dimensions, **When** processed, **Then** it contributes to per-(product × dimension-combo) revenue/count rollups.
2. **Given** configured dimensions [level_bucket, region, in_game_state, payer_tier], **When** I view monetization, **Then** I can see top packages broken down by each dimension.
3. **Given** a purchase reported by the client SDK and one reported by the server SDK, **When** both exist, **Then** the **server-reported** purchase is the trusted **revenue** record; the client SDK's role is a **context-companion event keyed by the SDK-minted `purchase_attempt_id`** (player_level, region, in_game_state, …) that joins to the server revenue row and enriches the monetization rollup but contributes zero money (resolved — research.md §D: "client is the messenger, not the money source of truth"; money still dedups durably by the store-issued `transaction_id`).

### User Story 5 — Cold-storage lifecycle for raw events (Priority: P3)

As the operator, raw events are appended to a per-game daily file, and a nightly job uploads yesterday's file to S3-compatible storage then deletes it locally — all configurable — so I keep a disposable backup / backfill escape hatch without paying for long-term hot storage.

**Why this priority**: Operationally important but not needed to demonstrate analytics value; the pipeline works without it. It also enables the future "rebuild dimensions forward from raw" escape hatch.

**Independent Test**: Run ingestion for a simulated day; confirm a daily file is written, the nightly job uploads it to an S3-compatible target, the local file is deleted, and behavior respects config (enable/disable, retention, bucket, credentials).

**Acceptance Scenarios**:
1. **Given** events for a game on a given day, **When** processed, **Then** they are appended to that game's daily raw file (compressed).
2. **Given** the nightly job runs, **When** yesterday's file exists, **Then** it is uploaded to the configured S3-compatible bucket and then removed locally.
3. **Given** cold storage is disabled in config, **When** events are processed, **Then** no raw files are written.

### Edge Cases

- **Redis loss**: Redis holds only transient queue data + hot counters (≤1 day). If Redis is lost, current-day live counters + in-flight queue are lost; durable results in Postgres and the daily raw file survive. **No automated replay in v1** (resolved — research.md §E). Three settings make this safe: aggregates flush to Postgres every **5 min** (config); Redis runs **AOF `everysec` + RDB** (in-flight-queue loss ≤ ~1 s); and workers **append the fsync'd raw file BEFORE updating counters** (write-ahead), so the day's raw file is always a complete superset — the manual rebuild floor. Getting the ordering wrong (counter-first) creates *counted-but-never-logged* events that break SC-008.
- **Duplicate / retried batches**: SDK offline-retry may resend a batch. Resolved — research.md §F: generic/economy events carry a per-event `event_id`; workers skip ids seen within a **24 h** Redis-backed window (rare double-count beyond the window is an accepted tradeoff for non-money events). **Purchases are deduped *durably* by the store-issued `transaction_id` (Postgres UNIQUE), never a Redis window** — an offline purchase retry can arrive days later, and money must never double-count.
- **Clock skew / late events**: A client's event timestamp may lag (offline play, wrong device clock). Resolved — research.md §G: bucket by **client-event-time with skew-correction** `corrected = client_event_time + (server_received_time − client_sent_time)` (Snowplow/Amplitude formula; SDK sends both timestamps). Under 60 s skew, trust the client clock verbatim; clamp future-dated events to server-now. Stored as **UTC epoch**; "a day" is the **platform logical day** (`utc_day(corrected + reporting_offset)`, single timezone — Foundation §4.7, upgraded in the hardening pass so a single-timezone base is not distorted by UTC-day cohorting). A day stays mutable for **48 h** then seals; later events for a sealed day are **quarantined to the raw file**. **Server-clock discipline** (hardening): the seal boundary and skew both read the server wall clock, so a **slewing NTP daemon is mandatory** (never a step) plus a sanity clamp + monotonicity alarm — a stepped clock would misplace events across a day/seal boundary permanently.
- **Anonymous → identified transition**: Pre-login events use an SDK anon id; then the game supplies a real user_id. v1 accepts the game-provided id as authoritative; full anon↔user merge is deferred.
- **Unknown / malformed events**: Events with unregistered names or bad shapes must not crash a worker. Resolved — research.md §H: **hybrid** — free-form named events are accepted and auto-registered into a per-game catalog; only the reserved typed kinds (`economy`/`purchase`/`session`) are strictly validated. Unparseable / nameless events are **dropped** (with a counter); typed-kind events missing required fields are **quarantined to the raw file** (the raw file is the dead-letter floor). Unique event names per game are capped (start at 500) so a buggy client can't explode the registry.
- **Dimension config change**: Changing monetization dimensions applies **forward only** (rebuild-forward); historical rollups keep their old dimensions.
- **High burst**: A traffic spike must not stall ingestion — the queue absorbs backpressure; the ingest endpoint stays fast.

---

## Requirements *(mandatory)*

### Functional Requirements

**Multi-tenancy & identity**
- **FR-001**: System MUST let the operator register multiple games, each with a unique SDK key. Ingestion uses one fixed platform endpoint (`POST /v1/events`); the game is identified by **deriving `game_id` from the authenticating key's class server-side** (not a per-game URL path — Q9/Foundation §4.5).
- **FR-002**: System MUST fully isolate data between games — no query or dashboard view may cross game boundaries.
- **FR-003**: System MUST authenticate every ingest request by SDK key and reject invalid/unknown keys without recording data.
- **FR-004**: A user MUST be identified by a stable game-provided `user_id`; the SDK MUST also generate an anonymous id for pre-login events. (Anon↔user merge is out of scope for v1.)

**Ingestion**
- **FR-005**: The client SDK MUST buffer events and send them as batched HTTP POSTs on a configurable interval/size, with offline retry.
- **FR-006**: The ingest endpoint MUST validate + enqueue batches and return quickly, without blocking on processing (queue-backed).
- **FR-007**: The system MUST provide a Node/NestJS **server SDK** for server-authoritative events (verified purchases, server-granted currency), sharing the same ingest contract.
- **FR-008**: The event model MUST support arbitrary named events with a property bag, plus typed sub-kinds for economy, purchase, and session events. Free-form named events MUST be accepted and **auto-registered** into a per-game event catalog (name, kind, first/last-seen, count, observed property keys/types); only the reserved typed kinds are **strictly validated**. (Schema policy resolved — research.md §H.)
- **FR-008a**: Every event MUST carry a client-generated `event_id`; workers MUST skip an `event_id` already seen within a **24 h** window (Redis SET with TTL). Purchases MUST additionally be deduped **durably** by the store-issued `transaction_id` (a Postgres UNIQUE key that outlives the transient window). Purchases MUST NEVER double-count. (Dedup resolved — research.md §F.)
- **FR-008b**: The client SDK MUST send a per-event `client_event_time` and a per-batch `client_sent_time`; the ingest collector MUST stamp `server_received_time`. Events MUST be bucketed by **skew-corrected client-event-time** `= client_event_time + (server_received_time − client_sent_time)`, stored as **UTC**. Future-dated events MUST be clamped to server-now; events arriving after a day has sealed (48 h grace) MUST be quarantined to the raw file, not folded into the sealed aggregate. (Event-time resolved — research.md §G.)
- **FR-008c**: Malformed events MUST NOT crash a worker: unparseable / nameless events are **dropped** (counted); typed-kind events missing required fields are **quarantined to the raw file**. Unique event names per game MUST be capped (default 500). (Resolved — research.md §H.)

**Processing pipeline**
- **FR-009**: Workers MUST consume batches from the queue and, per batch: **first** append raw to the daily file (fsync'd, if enabled) — **before** updating Redis hot counters and applying metric-specific processing. This write-ahead ordering guarantees the raw file is a complete superset of anything counted (the manual rebuild floor; see SC-008). (Resolved — research.md §E.)
- **FR-010**: The system MUST store only **processed results** and a **minimal per-user spine** in Postgres — never raw event logs. A small **purchase idempotency table** (`transaction_id` + minimal ref) is permitted alongside the spine and does not violate results-only (it holds uniqueness keys, not events).
- **FR-011**: Redis MUST hold only transient data (queue + hot counters) with a lifetime of ≤1 day; it MUST NOT be the source of truth for historical metrics. Redis MUST run with **AOF `appendonly yes` + `appendfsync everysec`** and `maxmemory-policy noeviction` (queue-correctness requirements).
- **FR-011a**: Aggregates MUST flush from Redis to Postgres on a configurable cadence (**default 5 min**) as an **idempotent absolute-value upsert** (`ON CONFLICT … DO UPDATE SET value = EXCLUDED.value`), so a retried flush is a no-op. This bounds the durable-result loss window on Redis failure. (Resolved — research.md §E.)

**Economy (sink/source)**
- **FR-012**: The system MUST record economy events classified as `source` or `sink`, with currency type, amount, and reason/category.
- **FR-013**: The system MUST compute and store, per game / per currency / per time bucket: total sources, total sinks, net flow, and sink ratio.
- **FR-014**: The system MUST provide a per-reason breakdown of top faucets and top drains.

**Retention**
- **FR-015**: On a user's first observed session, the system MUST create exactly one minimal user record `(game_id, user_id, first_seen, active_days_bitmap)`.
- **FR-016**: For each qualifying session, the system MUST compute the user's day-offset from first_seen (in UTC) and, **only if that offset's bit is not already set** in `active_days_bitmap`, set it and increment the corresponding install-date cohort's day-N retention tally. The set-once test keeps the tally correct without raw events and makes reprocessing/duplicates idempotent.
- **FR-017**: The dashboard MUST display D1/D7/D30 retention as returned-count ÷ cohort-size using the **classic Nth-day** definition (active exactly on day-offset N), **explicitly labelled** as such. Immature cohorts (where `today − cohort_date < offset`) MUST render as N/A / masked, never as a low number. (Retention definition resolved — research.md §B.)

**Monetization**
- **FR-018**: The system MUST record purchase events with product/package id, category, normalized price, and configurable context dimensions.
- **FR-019**: The system MUST roll up purchases by product × configured-dimension combinations to answer "top package by <dimension>".
- **FR-020**: Monetization dimensions MUST be configurable per game and applied **forward only** on change.
- **FR-021**: Server-reported purchases MUST be the trusted monetization **revenue** record. The client SDK MUST NOT contribute money; it MAY emit a **context-companion event keyed by the SDK-minted `purchase_attempt_id`** carrying purchase-time player context, which enriches the rollup via a join on `purchase_attempt_id` (money still dedups durably by `transaction_id`). If the companion event never arrives, the server revenue row MUST still stand alone with reduced dimensions. Every purchase row MUST carry `transaction_id`, `original_transaction_id`, a `source` flag (`client`/`server`), a `verified` boolean, `environment` (`prod`/`sandbox`, sandbox excluded from revenue), and raw local amount + currency stored separately from any normalized value. (Purchase truth resolved — research.md §D.)

**Funnels (design-only in v1)**
- **FR-022**: The data model MUST accommodate a **single per-game funnel** (ordered steps) as a forward-compatible design; funnel ingestion, computation, and UI are **deferred** beyond v1 (design-only, confirmed from brainstorm — no v1 funnel work).

**Cold storage**
- **FR-023**: The system MUST append raw events to per-game daily compressed files when cold storage is enabled.
- **FR-024**: A nightly job MUST upload yesterday's file to an S3-compatible target and delete it locally; all of this MUST be configurable (enable/disable, bucket, credentials, retention).

**Dashboard**
- **FR-025**: The dashboard MUST present, per game: live event counts, economy (sink/source), retention (D1/D7/D30), and segmented monetization.
- **FR-026**: The dashboard MUST read live figures from Redis and historical results from Postgres.

**Configuration**
- **FR-027**: All operational choices (batch interval, **Postgres flush cadence (default 5 min)**, **dedup window (default 24 h)**, **late-event grace / day-seal window (default 48 h)**, **per-game event-name cap (default 500)**, cold-storage on/off + target, monetization dimensions, retention day targets, level-bucket boundaries, **platform `reporting_offset` — the single timezone through which every day and seal is computed, set-once at install**) MUST be configurable so the operator can change strategy later without code changes.
- **FR-028** (added in hardening): The platform MUST protect the durable store it depends on — **automated Postgres backup (PITR) to the S3-compatible target, with tested restore** — since results/spine loss is not acceptable (Foundation §6) and the raw files are not a database backup.
- **FR-029** (added in hardening): Reversible infrastructure secrets (S3 credentials, FX material, erasure-ledger key) MUST be **encrypted with a master key held outside the database**; TLS is required for all credential/event traffic (the ingest API MUST refuse plain-HTTP bearer auth); the operator account MUST support brute-force lockout and optional MFA.
- **FR-030** (added in hardening): The platform MUST honor GDPR right-of-**access** (Art. 15) and portability (Art. 20), not only erasure — a subject-data export assembled from the spine family.

### Key Entities

- **Game (tenant)**: A registered game. Attributes: id, name, SDK key, config (dimensions, cold-storage settings, funnel def). Owns all downstream data.
- **Event (transient/raw)**: A single tracked action. Attributes: game_id, user_id (or anon id), session_id, name, **`event_id`** (dedup), **`client_event_time` / `client_sent_time`** (+ server-stamped `server_received_time`), property bag, kind (generic | economy | purchase | session). Lives only in Redis (transient) + daily raw file — **never** durably in Postgres.
- **User spine (durable, minimal)**: `(game_id, user_id, first_seen, active_days_bitmap)`. The only per-user data kept long-term; the bitmap (one bit per day-offset, ~4–8 bytes for D30 coverage) answers "which day-offset of this user is this, and have we counted it?".
- **Event catalog (durable, per-game auto-registry)**: one row per discovered event name — `(game_id, event_name, kind, first_seen, last_seen, count, property_keys{key:type}, status)`. Derived metadata only, not raw events. Feeds the self-populating dashboard; capped per game.
- **Purchase idempotency (durable, minimal)**: `(transaction_id UNIQUE, original_transaction_id, first_seen)`. Uniqueness keys for money dedup — not an event log.
- **Economy flow (result)**: Per game / currency / day / reason: source total, sink total (and derived net flow, sink ratio).
- **Retention result**: Per game / install-cohort / day-offset: returned-user count and cohort size.
- **Monetization rollup (result)**: Per game / product / dimension-combo / period: purchase count and normalized revenue.
- **Funnel definition (config, design-only v1)**: Per game: ordered list of steps (event + optional filters) and a conversion window.
- **Daily raw file (cold, disposable)**: Per game / per day compressed append log of raw events; uploaded to S3 then deleted locally.

---

## Success Criteria *(mandatory)*

*(Technology-agnostic, measurable.)*

- **SC-001**: An operator can register a new game and see live events from a freshly integrated client SDK in under 15 minutes of integration work.
- **SC-002**: Ingested batches are acknowledged fast enough that the client never blocks gameplay — ingest acknowledgement is independent of processing latency.
- **SC-003**: Two games running simultaneously show zero cross-contamination in any dashboard view.
- **SC-004**: For a known synthetic economy stream, dashboard sink/source totals, net flow, and sink ratio match hand-computed values exactly.
- **SC-005**: For a known synthetic population, reported D1/D7/D30 match hand-computed cohort retention exactly.
- **SC-006**: For a known synthetic purchase stream, "top package by <configured dimension>" matches hand-computed rollups exactly.
- **SC-007**: Postgres stores no raw event logs — only the user spine and result/rollup tables. Per-user storage stays small enough that 10M users cost far less than storing full event logs (target: user-spine row is a handful of small columns, no wide per-event indexes).
- **SC-008**: Losing Redis loses at most the current-day live counters and ≤~1 s of in-flight queue (AOF `everysec`); all durable results in Postgres (flushed ≤5 min ago) and the day's **complete** raw file survive — guaranteed by write-ahead ordering (raw-file append before counter update), so no event is ever counted-but-unlogged.
- **SC-009**: The entire platform (ingest API, workers, Redis, Postgres, dashboard) starts with a single `docker-compose up` on a modest VPS.
- **SC-010**: The nightly cold-storage job uploads the prior day's raw file to S3-compatible storage and removes it locally, respecting all config toggles.

---

## Clarifications

### Session 2026-07-17 (brainstorm — decided)

These were resolved during brainstorming and are **locked** for v1:

- **Q: Which metrics are non-negotiable for v1?** → Raw event tracking, sink/source economy, retention D1/D7/D30, and segmented monetization. **Funnels are deferred** (design-only per FR-022).
- **Q: How do events reach the system?** → Batched HTTP → queue (BullMQ/Redis) → workers → Redis hot counters + daily file, with periodic flush to Postgres.
- **Q: Platform stack?** → NestJS + TypeScript across ingest API, workers, and dashboard API. One language, matches the owner's games.
- **Q: Dashboard + deploy?** → Server-rendered panel inside NestJS (Nunjucks + Tailwind CSS + HTMX + Alpine.js + Chart.js); whole stack via Docker Compose. S3 target is any S3-compatible provider (MinIO / Arvan / etc.) so it works under network restrictions. No separate front-end app — the panel is served by the same NestJS process that runs ingest, workers, and the dashboard API.
- **Q: Where do durable facts live?** → Postgres stores **only processed results + a minimal per-user spine**, never raw logs. Redis is transient (≤1 day). Raw events live only in the disposable daily file (→ S3 → deleted local).
- **Q: Monetization segmentation model?** → **Configurable dimensions, rebuild-forward**: dimension changes apply from that day onward; historical rollups keep old dimensions. Raw files remain a theoretical backfill escape hatch (not a v1 feature).
- **Q: Cold-storage lifecycle?** → Append per-game daily file → nightly upload to S3-compatible storage → delete local; fully configurable.
- **Q: User identity?** → **Game provides the stable `user_id`**; SDK also mints an anon id for pre-login events. Full anon↔user merge deferred.
- **Q: SDK scope for v1?** → Browser/JS client SDK **and** Node/NestJS server SDK. React helper layer deferred.

### Session 2026-07-17 (research — resolved)

Deep multi-source research (one independent pass per question, verified against industry practice + locked constraints). Full rationale, numbers, and sources in `research.md §3`.

- **§B** Retention → **classic Nth-day**, explicitly labelled; per-user active-days bitmap; rolling disqualified by results-only storage (US3 / FR-015–017).
- **§D** Purchase truth → **server-only for revenue**; client emits a **context-companion event keyed by the SDK-minted `purchase_attempt_id`** (money still dedups durably by `transaction_id`); carry fields so reconcile-by-txn_id is a later upgrade (US4 / FR-021).
- **§E** Redis loss → **accept-loss, no replay**; **5-min idempotent absolute-upsert flush**; **AOF everysec + RDB**; **write-ahead raw-file ordering** (Edge Cases / FR-009/011/011a / SC-008).
- **§F** Dedup → **`event_id` + 24 h Redis window** for events; **durable `transaction_id` UNIQUE** for purchases (Edge Cases / FR-008a).
- **§G** Event-time → **client-time with skew-correction**, UTC, 48 h day-seal grace, quarantine beyond (Edge Cases / FR-008b).
- **§H** Schema → **hybrid accept-all + auto-registry**; strict typed kinds; drop-unparseable / quarantine-typed-invalid; 500-name cap (Edge Cases / FR-008/008c).

### Open questions — ALL RESOLVED (2026-07-17)

All 22 second-order questions in `research.md §6` are now **RESOLVED** — see `research.md §6` for the full ledger. Summary:

- **§B** (retention): active = session, immature-cohort masking, "classic Day-N" labelling — all adopted in [specs/005-retention/spec.md](../005-retention/spec.md).
- **§D** (purchase truth): refunds gross-only v1, FX via operator `fx_table` (Q8), sandbox exclusion, identity↔store mapping via server SDK, missing-companion accept — all adopted in [specs/006-monetization/spec.md](../006-monetization/spec.md) (and its design.md).
- **§E** (Redis loss): live-counter TTL end-of-UTC-day, dashboard seam (today=Redis / sealed=Postgres / "provisional" label), fsync-per-batch, per-class merge rules (hardening pass) — all adopted.
- **§F** (dedup): server-receive-time window, indefinite `transaction_id` retention, server SDK stamps `event_id` (Q2), SET-with-TTL v1 (Bloom deferred) — all adopted in [foundation.md](foundation.md).
- **§G** (bucketing): future-clamp, platform logical day (Foundation §4.7), SDK always stamps `client_sent_time` — all adopted.
- **§H** (schema): type-drift flag, reserved-name routing, default-deny PII scrubber, 500-name cap (FR-008c) — all adopted.
- **Cross-cutting**: §X-1 rebuild procedure specified (bridge 01.5), §X-2 session defined ([specs/003-sessions/spec.md](../003-sessions/spec.md)).

**Residual defers from the hardening pass** (documented, not blocking `/plan`): full anon↔user *merge* (the edge is now captured — Foundation §4.6 — merge deferred); the automated raw-rebuild *tool* (procedure specified); Redis HA replica + Sentinel (optional lever; single-Redis availability SPOF is named in 00.5 §8); DST-aware timezones (single fixed-offset zone assumed). See `research.md` §7–§8 for the full findings ledger.

---

## Assumptions

- **User base**: A solo operator (the owner) running a handful of their own games; not a public SaaS with untrusted third-party tenants in v1. Tenant isolation is for cleanliness/correctness, not adversarial multi-customer security.
- **Scale**: Indie-scale volume — comfortably within what Postgres (results-only) + Redis on a modest VPS handle. Columnar storage (ClickHouse/DuckDB) is an explicit future escape hatch, not a v1 dependency.
- **Trust boundary**: Client-reported economy/purchase data is inherently spoofable; **server-side events are the trusted source** for money/economy where trust matters (hence the server SDK in v1).
- **Network**: The operator can reach an S3-compatible endpoint and their own VPS; the platform phones home to nothing external and depends on no blocked cloud.
- **Data durability posture**: Raw event logs are explicitly disposable. Losing a day's raw file or the Redis cache is acceptable; losing durable Postgres results is not.
- **Funnels**: v1 designs the data model for one funnel per game but ships no funnel ingestion/compute/UI.

---

## Review & Acceptance Checklist

- [ ] All P1 + P2 user stories have passing acceptance scenarios.
- [ ] Multi-game isolation verified (SC-003).
- [ ] Economy, retention, and monetization results verified against hand-computed truth (SC-004/005/006).
- [ ] Postgres confirmed to hold no raw event logs (SC-007).
- [ ] Redis-loss behavior verified (SC-008).
- [ ] `docker-compose up` brings the whole stack up on a modest VPS (SC-009).
- [ ] Cold-storage nightly lifecycle verified with config toggles (SC-010).
- [x] All six original `[NEEDS CLARIFICATION]` markers resolved via research (research.md §3, 2026-07-17).
- [x] All research.md §6 second-order questions resolved (2026-07-17 — see research.md §6 full ledger).

---

## Next Steps

1. ~~Complete `research.md` to close the open `[NEEDS CLARIFICATION]` items (§B, §D–§H).~~ **Done — resolved 2026-07-17 (research.md §3).**
2. ~~Review the second-order open questions (`research.md §6`); settle at least the session definition (§X-2).~~ **Done — all 22 items resolved 2026-07-17 (research.md §6 full ledger).**
3. ~~Review the per-metric spec sheets (now merged into each story's `specs/00X-*/spec.md`); ratify or decline the funnels scope promotion; reconcile the per-user/per-payer spine-budget ledger against SC-007.~~ **Done — funnels DECLINED (design-only v1, FR-022 stands); spine ledger reconciled (within SC-007 intent at 10M users; three tightening items applied: economy depth default→off, lifetime-spend field declared in the monetization spec, funnels pruning recorded as v2 deliverable).**
4. ~~Establish the project constitution (`.specify/memory/constitution.md`).~~ **Done — six principles drafted: results-only storage, disposable raw data, config-driven, single-command deploy, server-trusted money, write-ahead raw-file durability.** (See Subagent C constitution seed in synthesis brief.)
5. **Proceed to `/plan`** — technical design: schemas, Redis key layout, worker jobs, API contracts. All §3 decisions locked; all §6 defaults confirmed; each metric sheet's §4/§5 is the per-metric design input; the constitution is ready to drop into `.specify/memory/constitution.md`.
