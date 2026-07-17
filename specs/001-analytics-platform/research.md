# Research: Self-Hosted Multi-Game Analytics Platform

**Feature**: `001-analytics-platform`
**Status**: Tool survey + domain knowledge **complete**; open clarifications (§B, §D–§H) **pending decision** before `/plan`.
**Purpose**: Back the spec with (1) the adopt-vs-build evidence, (2) the domain knowledge needed to design the metric engines, and (3) explicit research tasks for each open `[NEEDS CLARIFICATION]` marker in `spec.md`.

---

## 1. Adopt vs. Build — Tool Survey (COMPLETE)

**Conclusion: build a small custom NestJS + Postgres + Redis system.** No self-hostable OSS tool covers *game-economy sink/source* + *segmented monetization* + *multi-tenant* + *lightweight Postgres/Redis (no ClickHouse)* together.

### Candidate evaluation

| Tool | License | Infra | Multi-tenant | Sink/Source | Retention | Funnels | Seg. Monetization | Maintained | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **PostHog** (self-host) | MIT core (`ee/` proprietary) | ClickHouse + Postgres + Redis + Kafka + MinIO | ❌ 1 project/instance | ❌ | ✅ | ✅ | partial (custom props) | ✅ but self-host sunset toward Cloud | **Out** — heavy infra, no multi-tenant, ≤100k ev/mo pushes to blocked Cloud |
| **Countly CE** | AGPL-3.0 | MongoDB + Node | ✅ (apps) | partial (revenue, store-based) | ❌ Enterprise | ❌ Enterprise | ❌ Enterprise | ✅ (25.03.x, ~5.9k★) | **Out** — funnels/retention/segmentation are Enterprise-only; Mongo |
| **Matomo** | GPLv3 | PHP + MySQL | ✅ (sites) | ❌ | 💰 paid plugin | 💰 paid plugin | ❌ | ✅ | **Out** — web paradigm; paid features; no economy |
| **Umami** | MIT | **Postgres/MySQL only** | ✅ (sites/teams) | ❌ | shallow | shallow | ❌ | ✅ | **Reference only** — right infra shape, wrong feature set |
| **Plausible** | AGPL | Postgres + ClickHouse | ✅ | ❌ | ❌ (by design) | ❌ (by design) | ❌ | ✅ | **Out** |
| **Ackee / GoatCounter** | MIT | Mongo / single Go bin | limited | ❌ | ❌ | ❌ | ❌ | ✅ | **Out** — no custom events / funnels |
| **Talo** | MIT | includes **ClickHouse** | ✅ (games) | ❌ | ❌ | ❌ | ❌ | ✅ small (~95★) | **Out** — game backend, not economy/monetization analytics; ClickHouse |
| **RedMetrics** | OSS | — | — | — | — | — | — | ❌ archived 2021 | **Dead** |
| **GameAnalytics OSS** | client SDKs only | hosted backend | n/a | — | — | — | — | ✅ SDKs | **Out** — backend proprietary/hosted (blocked) |

### Sanctions note (why self-host is mandatory)

Google Analytics is blocked for Iranian accounts under US export sanctions — the block follows account origin, not IP, so a VPN doesn't reliably fix it and historical data is lost on termination. GameAnalytics is hosted SaaS with a proprietary backend (only client SDKs are open source). Any tool that phones home to a blocked cloud (PostHog Cloud, GA, GameAnalytics) is disqualified. Fully self-contained tools (run entirely on the operator's VPS, S3-compatible storage they control) are compatible; the only remaining constraint is *operational* — whether Docker images / npm registries are reachable at install time.

**Sources**: PostHog self-host support docs + FOSS repo; Countly Cohorts doc ("available in Countly Enterprise") + countly-server repo; Matomo free-vs-paid + Cohorts plugin; Umami docs; Talo backend repo; RedMetrics archived repos; NIAC / sanctions reporting on GA in Iran; GameAnalytics GitHub org.

---

## 2. Domain Knowledge (COMPLETE — feeds the metric engine design)

### §A — Game economy: SINK and SOURCE

**Definitions**
- **Source / Faucet / Tap** = mechanic that *creates* currency (quest rewards, loot, daily bonus, PvP wins, passive generators). Active (requires effort) vs passive (over time).
- **Sink / Drain** = mechanic that *permanently removes* currency (shop purchases, upgrades, crafting, repairs, cosmetics, time-skips, consumables). Sinks offset faucets to prevent inflation.

**Fields to capture per economy event** (core custom schema)
`game_id`, `user_id`, `session_id`, `timestamp`, **`flow_type` (`source`|`sink`)**, `currency_type` (gold/gems/energy — track per currency, they inflate independently), `amount` (positive magnitude), **`reason`/`category`** (`quest_reward`, `daily_bonus`, `shop_purchase:sword`, `upgrade:barracks`, …), `balance_after` (reconstructs wealth distribution without replaying events), plus player context (`player_level`, `region`, `days_since_install`, `is_payer`, optional `in_game_state`).

**Standard metrics**
- Total sources, total sinks per currency per time bucket.
- **Net flow** = Σsources − Σsinks (persistently positive ⇒ inflation risk).
- **Sink ratio** = Σsinks / Σsources (healthy live economies steer ≈ 1.0; slightly faucet-positive keeps a sense of progression).
- Currency depth / money supply (from `balance_after`), currency velocity, and per-`reason` faucet/drain breakdown (which faucet over-emits, which sink is ignored).

**Visualization**: stacked source-vs-sink time series (faucets above 0, drains below), net-flow line, per-reason top-faucet/top-drain bars, sliced by segment. Healthy = balanced inflow/outflow, sinks scale with faucets, controlled money supply, no single dominant faucet.

**Sources**: Machinations (game economy design); Lost Garden (value chains); economy inflation/balance articles.

### §B — Retention (D1/D7/D30)

**Minimum client data**: stable `user_id`, **first-seen/install timestamp** (Day 0 anchor), session timestamps (date suffices for day-N), optional "qualifying action" for stricter retention. Per user → the set of distinct active day-offsets from install.

**Definitions**
- **Classic / Nth-day ("On") retention**: % of cohort active *exactly* on day N. Independent per day, stable once day N passes. **Industry standard for D1/D7/D30 on daily-use games.** `active_on_day_N / cohort_size`, grouped by install-date cohort.
- **Range / bracket retention**: active on day N *or later within a bracket* — more forgiving, higher numbers.
- **Rolling / unbounded retention**: active on day N or any later day; a late return retroactively bumps earlier days. Better for infrequent-use apps.

**Benchmarks**: rough rule of thumb D1 ≈ 40% / D7 ≈ 20% / D30 ≈ 10%; hyper-casual lower; sim/strategy higher. D1 caps everything downstream.

**Computation (SQL-friendly)**: cohort by `date(first_seen)`; `day_offset = date(session) − date(first_seen)`; classic D-N = `count(distinct user where day_offset=N) / cohort_size`. Store as cohort × day-offset triangle (the retention heatmap).

**Sources**: GoPractice (retention facets); Amplitude N-day for mobile games; Mighty Bear cohort retention; Solsten / GameAnalytics benchmarks.

### §C — Funnels (design-only in v1)

Funnel = ordered list of **steps** (event + optional property filters) + a **conversion window**. Per-event primitives: who / what / when. Ordering modes: sequential (others allowed between), strict (immediately after), any-order. Conversion window = max elapsed first→last step. Attribution: first-touch vs any-touch. Outputs: per-step counts, step-to-step %, overall %, drop-off, time-to-convert, breakable by segment.

**Sources**: PostHog funnels; funnel-analysis-in-SQL references.

### §D — Segmented monetization

Denormalize context onto **every purchase event** so slicing is a `GROUP BY`, not a join back through session state:
- **Transaction facts**: `transaction_id`, `timestamp`, `game_id`, `user_id`, `product_id`, `product_category`, `price_local`, `price_usd` (normalize), `quantity`, `is_first_purchase`.
- **Player-context dimensions (at purchase time)**: `player_level` (→ level_bucket), `region`, `device`, `days_since_install`, `install_cohort`, `payer_tier` (first/repeat/whale), `sessions_before_purchase`, **`in_game_state`** (`post_defeat`, `out_of_energy`, `pre_boss` — turns "which package" into "which package *when out of energy at level 12 in region X*").
- **Derived**: Revenue = DAU × conversion% × ARPPU; also ARPU, ARPDAU, conversion rate, whale concentration. Segmentation = momentary slice; cohort = time-based LTV evolution.

**Sources**: GA4 ecommerce dimensions; Deconstructor of Fun (monetization); cohort purchase-segmentation references.

---

## 3. Open Research Tasks (RESOLVE BEFORE `/plan`)

Each closes a `[NEEDS CLARIFICATION]` marker in `spec.md`. Each has options + a recommendation; the operator confirms or overrides.

### §B-task — Retention definition for v1
- **Question**: Classic Nth-day, bracket, or rolling for D1/D7/D30?
- **Options**: (a) Classic Nth-day — industry standard, stable, simplest to store as cohort×day triangle. (b) Bracket — more forgiving, higher numbers. (c) Rolling — best for infrequent-use apps but needs retroactive updates (harder with results-only storage).
- **Recommendation**: **(a) Classic Nth-day** — standard, and it maps cleanly onto the results-only cohort×day-offset table without retroactive rewrites.
- **Decision**: _pending_

### §D-task — Client vs server purchase reconciliation
- **Question**: When both client and server report a purchase (or only client does), what's authoritative?
- **Options**: (a) Server-only trusted; client purchase events ignored for revenue (client may still fire for funnel/context). (b) Client flagged "unverified" and shown separately. (c) Reconcile by `transaction_id` (client enriches context, server confirms money).
- **Recommendation**: **(a) for v1** (server = money truth; simplest), with `transaction_id` carried so (c) is a later upgrade.
- **Decision**: _pending_

### §E-task — Redis data-loss window & replay
- **Question**: What loss is acceptable on Redis failure, and do we replay in-flight events from the raw file?
- **Options**: (a) Accept loss of current-day live counters + in-flight queue; no replay (durable results already flushed to Postgres periodically). (b) Replay unprocessed events from today's raw file on restart.
- **Recommendation**: **(a) for v1** — matches "raw is disposable"; define the Postgres-flush cadence so the durable-result loss window is bounded (e.g. flush every N min). Replay is a later hardening.
- **Decision**: _pending_ (also fixes the flush cadence, which bounds SC-008)

### §F-task — Duplicate / retried-batch dedup
- **Question**: Offline retry may resend a batch. Dedup or tolerate double-count?
- **Options**: (a) Client attaches a unique `event_id` per event; workers skip ids seen within a short Redis-backed window. (b) Batch-level idempotency key. (c) Tolerate rare double-counting (simplest, acceptable at indie scale for non-money events, NOT for purchases).
- **Recommendation**: **(a) `event_id` + short dedup window** for economy/generic events; **purchases always deduped by `transaction_id`** regardless. Money must never double-count.
- **Decision**: _pending_

### §G-task — Event-time bucketing & late events
- **Question**: Bucket by server-receive-time or client-event-time? How are late/offline events handled?
- **Options**: (a) Client-event-time with a bounded lateness window (e.g. accept up to X hours late into the correct day; drop or clamp beyond). (b) Server-receive-time (simplest, but wrong for offline play and skewed clocks). (c) Client-time with sanity clamp against server time.
- **Recommendation**: **(c) client-event-time + sanity clamp** — trust the client clock within a tolerance vs server-receive-time; clamp/quarantine wild skew. Retention/economy day bucketing then reflects real play.
- **Decision**: _pending_

### §H-task — Event schema policy
- **Question**: Strict per-game registered event names/shapes, or schema-less accept-all?
- **Options**: (a) Schema-less accept-all with reserved typed kinds (economy/purchase/session validated, everything else free-form) — fastest to integrate. (b) Strict registry of event names per game — cleaner dashboards, more setup friction. (c) Hybrid: accept-all but auto-discover event names into a registry for the dashboard.
- **Recommendation**: **(c) hybrid** — accept-all so integration is frictionless, but auto-register discovered event names per game so the dashboard has a clean, self-populating list; economy/purchase/session kinds are strictly validated.
- **Decision**: _pending_

---

## 4. Reference Architecture Decisions (from brainstorm — context for `/plan`)

- **Modular monolith**: one NestJS codebase with internal modules (ingest, workers, metrics, dashboard-api), structured so ingest can be extracted into its own service later without a rewrite. Rejected: separate services now (premature), event-sourced Postgres (the heavy model being avoided).
- **Storage split**: Redis = transient queue + hot counters (≤1 day, disposable); Postgres = user spine + result/rollup tables only; daily gzip raw files = cold backup → S3 → deleted local.
- **S3-compatible target** (MinIO / Arvan / any) so it works under network restrictions and phones home to nothing blocked.
- **Config-driven**: batch interval, cold-storage toggles, monetization dimensions (rebuild-forward), retention day targets, level-bucket boundaries, flush cadence — all config, no code changes to shift strategy.

---

## 5. Sources (load-bearing)

- PostHog self-host limits + FOSS: posthog.com/docs/self-host/open-source/support · github.com/PostHog/posthog-foss
- Countly CE Enterprise-gating: support.countly.com Cohorts article · github.com/countly/countly-server
- Matomo paid funnels/cohorts: matomo free-vs-paid · plugins.matomo.org/Cohorts
- Umami (Postgres-only, shallow funnels): docs.umami.is
- Talo (MIT, ClickHouse, no economy/retention): github.com/TaloDev/backend
- Sanctions on GA from Iran: niacouncil.org · GameAnalytics GitHub org
- Economy sink/source: machinations.io · lostgarden.com value-chains
- Retention: gopractice.io · amplitude.com N-day for mobile games
- Funnels: posthog.com/docs/product-analytics/funnels
- Segmented monetization: deconstructoroffun.com · GA4 ecommerce dimensions
