# Feature Specification: Self-Hosted Multi-Game Analytics Platform

**Feature Branch**: `001-analytics-platform`
**Created**: 2026-07-17
**Status**: Draft — pending research (see `research.md`) and stakeholder review
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
3. **Given** a cohort of known size, **When** I view retention, **Then** D1/D7/D30 are shown as returned-count ÷ cohort-size for the classic (Nth-day) definition. `[NEEDS CLARIFICATION: confirm classic Nth-day is the v1 definition vs bracket/rolling — see research.md §B]`

### User Story 4 — Segmented monetization analytics (Priority: P2)

As a game developer, I can see not just which package sold most, but which package sold most **to whom / when** — sliced by configurable dimensions (e.g. player level bucket, region, in-game state, payer tier) — using server-verified purchase data.

**Why this priority**: Directly requested ("users in this area / at these levels / in these situations tend to buy X"). Segmentation is the differentiator over a plain revenue bar chart.

**Independent Test**: Send purchases carrying context dimensions; confirm the dashboard can answer "top package by <dimension>" for the configured dimensions and that server-sent purchases are the trusted source.

**Acceptance Scenarios**:
1. **Given** a purchase event with product, price, and context dimensions, **When** processed, **Then** it contributes to per-(product × dimension-combo) revenue/count rollups.
2. **Given** configured dimensions [level_bucket, region, in_game_state, payer_tier], **When** I view monetization, **Then** I can see top packages broken down by each dimension.
3. **Given** a purchase reported by the client SDK and one reported by the server SDK, **When** both exist, **Then** the **server-reported** purchase is the trusted record. `[NEEDS CLARIFICATION: client-purchase handling — ignored, flagged-unverified, or reconciled? see research.md §D]`

### User Story 5 — Cold-storage lifecycle for raw events (Priority: P3)

As the operator, raw events are appended to a per-game daily file, and a nightly job uploads yesterday's file to S3-compatible storage then deletes it locally — all configurable — so I keep a disposable backup / backfill escape hatch without paying for long-term hot storage.

**Why this priority**: Operationally important but not needed to demonstrate analytics value; the pipeline works without it. It also enables the future "rebuild dimensions forward from raw" escape hatch.

**Independent Test**: Run ingestion for a simulated day; confirm a daily file is written, the nightly job uploads it to an S3-compatible target, the local file is deleted, and behavior respects config (enable/disable, retention, bucket, credentials).

**Acceptance Scenarios**:
1. **Given** events for a game on a given day, **When** processed, **Then** they are appended to that game's daily raw file (compressed).
2. **Given** the nightly job runs, **When** yesterday's file exists, **Then** it is uploaded to the configured S3-compatible bucket and then removed locally.
3. **Given** cold storage is disabled in config, **When** events are processed, **Then** no raw files are written.

### Edge Cases

- **Redis loss**: Redis holds only transient queue data + hot counters (≤1 day). If Redis is lost, in-flight/live counters are lost but durable results in Postgres and the daily raw file survive. `[NEEDS CLARIFICATION: acceptable data-loss window and whether any in-flight replay from raw file is expected — see research.md §E]`
- **Duplicate / retried batches**: SDK offline-retry may resend a batch. `[NEEDS CLARIFICATION: dedup strategy — client-supplied event ids + idempotency, or accept small double-counting? see research.md §F]`
- **Clock skew / late events**: A client's event timestamp may lag (offline play, wrong device clock). Which day does a late event count toward? `[NEEDS CLARIFICATION: server-receive-time vs client-event-time bucketing — see research.md §G]`
- **Anonymous → identified transition**: Pre-login events use an SDK anon id; then the game supplies a real user_id. v1 accepts the game-provided id as authoritative; full anon↔user merge is deferred.
- **Unknown / malformed events**: Events with unregistered names or bad shapes must not crash a worker; they are dropped or quarantined. `[NEEDS CLARIFICATION: strict schema-per-game vs schema-less accept-all — see research.md §H]`
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
- **FR-008**: The event model MUST support arbitrary named events with a property bag, plus typed sub-kinds for economy and purchase events.

**Processing pipeline**
- **FR-009**: Workers MUST consume batches from the queue and, per event: append raw to the daily file (if enabled), update Redis hot counters, and apply metric-specific processing.
- **FR-010**: The system MUST store only **processed results** and a **minimal per-user spine** in Postgres — never raw event logs.
- **FR-011**: Redis MUST hold only transient data (queue + hot counters) with a lifetime of ≤1 day; it MUST NOT be the source of truth for historical metrics.

**Economy (sink/source)**
- **FR-012**: The system MUST record economy events classified as `source` or `sink`, with currency type, amount, and reason/category.
- **FR-013**: The system MUST compute and store, per game / per currency / per time bucket: total sources, total sinks, net flow, and sink ratio.
- **FR-014**: The system MUST provide a per-reason breakdown of top faucets and top drains.

**Retention**
- **FR-015**: On a user's first observed session, the system MUST create exactly one minimal user record `(game_id, user_id, first_seen)`.
- **FR-016**: For each session, the system MUST compute the user's day-offset from first_seen and increment the corresponding install-date cohort's day-N retention tally.
- **FR-017**: The dashboard MUST display D1/D7/D30 retention as returned-count ÷ cohort-size. (Exact definition pending — see clarification in US3.)

**Monetization**
- **FR-018**: The system MUST record purchase events with product/package id, category, normalized price, and configurable context dimensions.
- **FR-019**: The system MUST roll up purchases by product × configured-dimension combinations to answer "top package by <dimension>".
- **FR-020**: Monetization dimensions MUST be configurable per game and applied **forward only** on change.
- **FR-021**: Server-reported purchases MUST be the trusted monetization record.

**Funnels (design-only in v1)**
- **FR-022**: The data model MUST accommodate a **single per-game funnel** (ordered steps) as a forward-compatible design, even though funnel computation/UI is **deferred** beyond v1. `[NEEDS CLARIFICATION: confirm funnels are design-only in v1 with no ingestion/UI work — deferred per brainstorm]`

**Cold storage**
- **FR-023**: The system MUST append raw events to per-game daily compressed files when cold storage is enabled.
- **FR-024**: A nightly job MUST upload yesterday's file to an S3-compatible target and delete it locally; all of this MUST be configurable (enable/disable, bucket, credentials, retention).

**Dashboard**
- **FR-025**: The dashboard MUST present, per game: live event counts, economy (sink/source), retention (D1/D7/D30), and segmented monetization.
- **FR-026**: The dashboard MUST read live figures from Redis and historical results from Postgres.

**Configuration**
- **FR-027**: All operational choices (batch interval, cold-storage on/off + target, monetization dimensions, retention day targets, level-bucket boundaries) MUST be configurable so the operator can change strategy later without code changes.

### Key Entities

- **Game (tenant)**: A registered game. Attributes: id, name, SDK key, config (dimensions, cold-storage settings, funnel def). Owns all downstream data.
- **Event (transient/raw)**: A single tracked action. Attributes: game_id, user_id (or anon id), session_id, name, timestamp, property bag, kind (generic | economy | purchase | session). Lives only in Redis (transient) + daily raw file — **never** durably in Postgres.
- **User spine (durable, minimal)**: `(game_id, user_id, first_seen, last_seen/day markers)`. The only per-user data kept long-term; exists to answer "which day of this user is this?".
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
- **SC-008**: Losing Redis loses at most the current-day live counters and in-flight queue; all durable results in Postgres and the day's raw file survive.
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

### Open — to resolve in research / planning

Tracked as `[NEEDS CLARIFICATION]` above and expanded in `research.md`:

- **§B** Retention definition: classic Nth-day vs bracket vs rolling for v1 (US3 / FR-017).
- **§D** Client-vs-server purchase reconciliation policy (US4 / FR-021).
- **§E** Acceptable Redis data-loss window and any in-flight replay (Edge Cases / SC-008).
- **§F** Duplicate/retried-batch dedup strategy — idempotency keys vs tolerated double-count (Edge Cases).
- **§G** Event-time bucketing: server-receive-time vs client-event-time, and late-event handling (Edge Cases).
- **§H** Event schema policy: strict per-game registered events vs schema-less accept-all (Edge Cases / FR-008).

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
- [ ] All `[NEEDS CLARIFICATION]` markers resolved (via `research.md`) before `/plan`.

---

## Next Steps

1. Complete `research.md` to close the open `[NEEDS CLARIFICATION]` items (§B, §D–§H).
2. Establish the project **constitution** (`.specify/memory/constitution.md`) — principles: results-only storage, disposable raw data, config-driven, single-command deploy, server-trusted money.
3. Proceed to `/plan` (technical design: schemas, Redis key layout, worker jobs, API contracts) once clarifications are closed.
