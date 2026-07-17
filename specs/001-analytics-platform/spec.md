# Feature Specification: Self-Hosted Multi-Game Analytics Platform

**Feature Branch**: `001-analytics-platform`
**Created**: 2026-07-17
**Status**: Draft — **all six `[NEEDS CLARIFICATION]` resolved via research (2026-07-17)**; second-order open questions tracked in `research.md §6`. Pending stakeholder review, then `/plan`.
**Input**: Owner wants a lightweight, self-hostable analytics platform for their own Phaser.js / React games (with NestJS backends), because GameAnalytics and Google Analytics are unusable under sanctions / network restrictions. Must serve **multiple games** from one install, lean heavily on Redis + a queue for processing, store only **processed results** (not raw logs) in Postgres, and keep disposable daily raw-event files as cold backup (uploaded to S3, then deleted locally).

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

Each user story is an independently testable, independently valuable slice. Priorities: **P1** = MVP foundation, **P2** = core value, **P3** = complete-the-picture.

### User Story 1 — Register a game and start collecting events (Priority: P1)

As a game developer, I can register a new game in the platform, receive an SDK key + ingest URL, drop the SDK into my Phaser/React game, and immediately see raw events (button clicks, game actions, screen views) arriving and counting up.

**Why this priority**: Nothing else can be built or verified until multi-tenant ingestion works end-to-end. This is the foundation every other metric depends on.

**Independent Test**: Register a game via the dashboard, wire the SDK into a throwaway page, fire events, and confirm live event counts increment for that game (and only that game). Fully demonstrable on its own.

**Acceptance Scenarios**:
1. **Given** I am logged into the dashboard, **When** I create a new game "MyGame", **Then** I receive a unique SDK key and an ingest URL scoped to that game.
2. **Given** the SDK is initialized with a valid key, **When** the game fires a batch of events, **Then** the ingest endpoint accepts them quickly (returns without waiting on processing) and they appear in that game's live counters within a configurable flush interval.
3. **Given** a request presents an invalid or unknown SDK key, **When** it hits the ingest endpoint, **Then** it is rejected and no data is recorded.
4. **Given** two different games are registered, **When** each sends events, **Then** their data is fully isolated — one game's dashboard never shows another game's events.

### User Story 2 — Track the game economy (sink/source) (Priority: P2)

As a game developer, I can send currency-flow events (currency granted = **source/faucet**, currency spent = **sink/drain**) and see, per game, total sources vs total sinks per currency over time, net flow, sink ratio, and a per-reason breakdown of the biggest faucets and biggest drains.

**Why this priority**: This is the headline feature no off-the-shelf tool provides and the primary reason to build. It is independently valuable: an economy dashboard alone justifies the platform.

**Independent Test**: Emit a stream of source and sink events across categories and currencies; confirm the dashboard shows correct totals, net flow, sink ratio, and top-faucet/top-drain breakdowns for the chosen period.

**Acceptance Scenarios**:
1. **Given** economy events tagged `source`/`sink` with a currency type, amount, and reason, **When** processed, **Then** per-currency, per-day totals of sources and sinks are stored and displayed.
2. **Given** a day's sources and sinks, **When** I view the economy dashboard, **Then** I see net flow (Σsources − Σsinks) and sink ratio (Σsinks / Σsources) per currency.
3. **Given** many reasons/categories, **When** I view the breakdown, **Then** I see the top faucets and top sinks by contribution.

### User Story 3 — Measure retention (D1 / D7 / D30) (Priority: P2)

As a game developer, I can see how many players return on day 1, day 7, and day 30 after their first session, expressed as a percentage of each install-date cohort.

**Why this priority**: Retention is a core health metric and directly drove the "minimal per-user spine" storage decision. Independently valuable: a retention curve stands alone.

**Independent Test**: Simulate users with known first-seen dates and return days; confirm the platform correctly buckets each user by cohort and day-offset and reports D1/D7/D30 percentages matching the hand-computed truth.

**Acceptance Scenarios**:
1. **Given** a user's first session, **When** processed, **Then** a minimal user record (game_id, user_id, first_seen) is created exactly once.
2. **Given** a returning user, **When** processed, **Then** the platform computes their day-offset from first_seen and increments the correct cohort's day-N retention tally.
3. **Given** a cohort of known size, **When** I view retention, **Then** D1/D7/D30 are shown as returned-count ÷ cohort-size for the **classic Nth-day** definition (active *exactly* on day-offset N), and the metric is **explicitly labelled** "classic Day-N retention" (resolved — research.md §B: rolling is disqualified by results-only storage; Mixpanel-style unbounded is a different, unlabelled number).

### User Story 4 — Segmented monetization analytics (Priority: P2)

As a game developer, I can see not just which package sold most, but which package sold most **to whom / when** — sliced by configurable dimensions (e.g. player level bucket, region, in-game state, payer tier) — using server-verified purchase data.

**Why this priority**: Directly requested ("users in this area / at these levels / in these situations tend to buy X"). Segmentation is the differentiator over a plain revenue bar chart.

**Independent Test**: Send purchases carrying context dimensions; confirm the dashboard can answer "top package by <dimension>" for the configured dimensions and that server-sent purchases are the trusted source.

**Acceptance Scenarios**:
1. **Given** a purchase event with product, price, and context dimensions, **When** processed, **Then** it contributes to per-(product × dimension-combo) revenue/count rollups.
2. **Given** configured dimensions [level_bucket, region, in_game_state, payer_tier], **When** I view monetization, **Then** I can see top packages broken down by each dimension.
3. **Given** a purchase reported by the client SDK and one reported by the server SDK, **When** both exist, **Then** the **server-reported** purchase is the trusted **revenue** record; the client SDK's role is a **context-companion event keyed by `transaction_id`** (player_level, region, in_game_state, …) that enriches the monetization rollup but contributes zero money (resolved — research.md §D: "client is the messenger, not the money source of truth"; both are deduped by the store-issued `transaction_id`).

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
- **Clock skew / late events**: A client's event timestamp may lag (offline play, wrong device clock). Resolved — research.md §G: bucket by **client-event-time with skew-correction** `corrected = client_event_time + (server_received_time − client_sent_time)` (Snowplow/Amplitude formula; SDK sends both timestamps). Under 60 s skew, trust the client clock verbatim; clamp future-dated events to server-now. Stored as **UTC**; "a day" is UTC in v1. A day stays mutable for **48 h** (grace, tied to the flush cadence) then seals; events later than that for a sealed day are **quarantined to the raw file**, never folded into or clamped onto a sealed aggregate.
- **Anonymous → identified transition**: Pre-login events use an SDK anon id; then the game supplies a real user_id. v1 accepts the game-provided id as authoritative; full anon↔user merge is deferred.
- **Unknown / malformed events**: Events with unregistered names or bad shapes must not crash a worker. Resolved — research.md §H: **hybrid** — free-form named events are accepted and auto-registered into a per-game catalog; only the reserved typed kinds (`economy`/`purchase`/`session`) are strictly validated. Unparseable / nameless events are **dropped** (with a counter); typed-kind events missing required fields are **quarantined to the raw file** (the raw file is the dead-letter floor). Unique event names per game are capped (start at 500) so a buggy client can't explode the registry.
- **Dimension config change**: Changing monetization dimensions applies **forward only** (rebuild-forward); historical rollups keep their old dimensions.
- **High burst**: A traffic spike must not stall ingestion — the queue absorbs backpressure; the ingest endpoint stays fast.

---

## Requirements *(mandatory)*

### Functional Requirements

**Multi-tenancy & identity**
- **FR-001**: System MUST let the operator register multiple games, each with a unique SDK key and a game-scoped ingest URL.
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
- **FR-021**: Server-reported purchases MUST be the trusted monetization **revenue** record. The client SDK MUST NOT contribute money; it MAY emit a **context-companion event keyed by `transaction_id`** carrying purchase-time player context, which enriches the rollup via a join on `transaction_id`. If the companion event never arrives, the server revenue row MUST still stand alone with reduced dimensions. Every purchase row MUST carry `transaction_id`, `original_transaction_id`, a `source` flag (`client`/`server`), a `verified` boolean, `environment` (`prod`/`sandbox`, sandbox excluded from revenue), and raw local amount + currency stored separately from any normalized value. (Purchase truth resolved — research.md §D.)

**Funnels (design-only in v1)**
- **FR-022**: The data model MUST accommodate a **single per-game funnel** (ordered steps) as a forward-compatible design; funnel ingestion, computation, and UI are **deferred** beyond v1 (design-only, confirmed from brainstorm — no v1 funnel work).

**Cold storage**
- **FR-023**: The system MUST append raw events to per-game daily compressed files when cold storage is enabled.
- **FR-024**: A nightly job MUST upload yesterday's file to an S3-compatible target and delete it locally; all of this MUST be configurable (enable/disable, bucket, credentials, retention).

**Dashboard**
- **FR-025**: The dashboard MUST present, per game: live event counts, economy (sink/source), retention (D1/D7/D30), and segmented monetization.
- **FR-026**: The dashboard MUST read live figures from Redis and historical results from Postgres.

**Configuration**
- **FR-027**: All operational choices (batch interval, **Postgres flush cadence (default 5 min)**, **dedup window (default 24 h)**, **late-event grace / day-seal window (default 48 h)**, **per-game event-name cap (default 500)**, cold-storage on/off + target, monetization dimensions, retention day targets, level-bucket boundaries, per-game reporting timezone offset) MUST be configurable so the operator can change strategy later without code changes.

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
- **Q: Dashboard + deploy?** → Next.js dashboard; whole stack via Docker Compose. S3 target is any S3-compatible provider (MinIO / Arvan / etc.) so it works under network restrictions.
- **Q: Where do durable facts live?** → Postgres stores **only processed results + a minimal per-user spine**, never raw logs. Redis is transient (≤1 day). Raw events live only in the disposable daily file (→ S3 → deleted local).
- **Q: Monetization segmentation model?** → **Configurable dimensions, rebuild-forward**: dimension changes apply from that day onward; historical rollups keep old dimensions. Raw files remain a theoretical backfill escape hatch (not a v1 feature).
- **Q: Cold-storage lifecycle?** → Append per-game daily file → nightly upload to S3-compatible storage → delete local; fully configurable.
- **Q: User identity?** → **Game provides the stable `user_id`**; SDK also mints an anon id for pre-login events. Full anon↔user merge deferred.
- **Q: SDK scope for v1?** → Browser/JS client SDK **and** Node/NestJS server SDK. React helper layer deferred.

### Session 2026-07-17 (research — resolved)

Deep multi-source research (one independent pass per question, verified against industry practice + locked constraints). Full rationale, numbers, and sources in `research.md §3`.

- **§B** Retention → **classic Nth-day**, explicitly labelled; per-user active-days bitmap; rolling disqualified by results-only storage (US3 / FR-015–017).
- **§D** Purchase truth → **server-only for revenue**; client emits a **context-companion event keyed by `transaction_id`**; carry fields so reconcile-by-txn_id is a later upgrade (US4 / FR-021).
- **§E** Redis loss → **accept-loss, no replay**; **5-min idempotent absolute-upsert flush**; **AOF everysec + RDB**; **write-ahead raw-file ordering** (Edge Cases / FR-009/011/011a / SC-008).
- **§F** Dedup → **`event_id` + 24 h Redis window** for events; **durable `transaction_id` UNIQUE** for purchases (Edge Cases / FR-008a).
- **§G** Event-time → **client-time with skew-correction**, UTC, 48 h day-seal grace, quarantine beyond (Edge Cases / FR-008b).
- **§H** Schema → **hybrid accept-all + auto-registry**; strict typed kinds; drop-unparseable / quarantine-typed-invalid; 500-name cap (Edge Cases / FR-008/008c).

### Open — surfaced *by* the above (resolve in `/plan` or a follow-up clarify)

Resolving §B–§H exposed second-order questions, each with a default recommendation in **`research.md §6`**. Highest-leverage ones to settle before/at `/plan`:

- **§X-2** **Session definition** — what starts/ends a session (inactivity timeout?). `session_id` is referenced but never defined; both retention ("active" = session) and monetization (`sessions_before_purchase`) depend on it. *(Recommend: SDK-managed session, config inactivity timeout ~30 min.)*
- **§D-1** **Refunds/chargebacks** — gross-only v1 vs net revenue. *(Recommend: gross-only + `refunded` flag + notification hook for v2.)*
- **§D-2** **Currency normalization** — who owns FX and the as-of date for `price_usd`. *(Recommend: store raw local + currency; config FX table stamped at purchase date.)*
- **§G-3 / §B day-boundary** **Timezone-change policy** — a reporting-timezone change must be display-only (never re-bucket sealed aggregates) to preserve retention immutability.
- **§X-1** **Manual raw-file rebuild runbook** — the raw file is the recovery floor but v1 ships no rebuild tooling; document the manual procedure.
- **§H-3** **PII in free-form props** — accept-all can carry PII into the catalog; config denylist / hashing (solo-operator trust assumption).

*(Full list — §B-1..3, §D-1..5, §E-1..4, §F-1..4, §G-1..4, §H-1..4, §X-1..2 — in `research.md §6`.)*

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
- [ ] Highest-leverage second-order questions (research.md §6 — esp. session definition §X-2) settled before/at `/plan`.

---

## Next Steps

1. ~~Complete `research.md` to close the open `[NEEDS CLARIFICATION]` items (§B, §D–§H).~~ **Done — resolved 2026-07-17 (research.md §3).**
2. Review the second-order open questions (`research.md §6`); settle at least the **session definition (§X-2)** before `/plan`, since retention and monetization both depend on it.
3. Establish the project **constitution** (`.specify/memory/constitution.md`) — principles: results-only storage, disposable raw data, config-driven, single-command deploy, server-trusted money, **write-ahead raw-file durability**.
4. Proceed to `/plan` (technical design: schemas, Redis key layout, worker jobs, API contracts) with §3 decisions locked and §6 defaults in hand.
