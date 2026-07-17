# Research: Self-Hosted Multi-Game Analytics Platform

**Feature**: `001-analytics-platform`
**Status**: Tool survey + domain knowledge **complete**; open clarifications (§B, §D–§H) **RESOLVED** (see §3, decided 2026-07-17). New questions surfaced during this research are tracked in §6.
**Purpose**: Back the spec with (1) the adopt-vs-build evidence, (2) the domain knowledge needed to design the metric engines, (3) the resolved decisions for each `[NEEDS CLARIFICATION]` marker in `spec.md`, and (4) the second-order questions that resolving them exposed.

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

## 3. Clarification Decisions (RESOLVED 2026-07-17 — deep multi-source research)

Each closes a `[NEEDS CLARIFICATION]` marker in `spec.md`. Each was pressure-tested by an independent research pass against real industry practice **and** the locked v1 constraints (results-only Postgres, disposable raw, indie scale). Second-order questions surfaced by these decisions are in **§6**.

### §B — Retention definition for v1 → **DECIDED: (a) Classic Nth-day**
- **Question**: Classic Nth-day, bracket, or rolling for D1/D7/D30?
- **Decision**: **(a) Classic Nth-day** ("active *exactly* on day-offset N"). D_N = `retained_users(offset=N) / cohort_size`.
- **Rationale**:
  - Classic Day-N is the reference metric across the game/mobile-marketing stack (Adjust, AppsFlyer, GameAnalytics, GoPractice, devtodev) and Amplitude recommends it over unbounded for *daily-use* games. Our games are daily-session style.
  - **It is the only definition that is write-once under results-only storage.** Rolling (c) requires retroactively bumping earlier day-N cells when a user returns late — `retained_on_day_N = max(active_offsets) ≥ N` depends on a *future* maximum, so a late return rewrites lower cells. That is impossible without per-user return history or a raw re-scan, both forbidden in v1. Classic's test is `N ∈ active_offsets` — idempotent and order-independent.
  - **Vendor-disagreement caveat (load-bearing):** Mixpanel *defaults to "On or After" (unbounded/rolling)*, while Amplitude and game tooling default to classic Day-N. "Industry standard" is split by tool type. ⇒ the UI **must explicitly label** the metric "classic Day-N retention" so numbers are comparable to GameAnalytics/Adjust benchmarks and not silently confused with Mixpanel-style unbounded numbers.
- **Storage shape (results-only)**: per-user spine row gains `active_days_bitmap` (one bit per day-offset since `first_seen`, capped at the longest reported offset; `BYTEA`/`BIT VARYING`). On each qualifying session: `offset = active_date − first_seen_date`; if that bit is unset, set it and increment the result cell. Result table `retention_cohort(game_id, cohort_date, day_offset, retained_users)` + `cohort_size(game_id, cohort_date, size)`. This table *is* the full heatmap triangle; D1/D7/D30 are just offsets 1/7/30 — so headline and heatmap use the **same** definition automatically.
- **Numbers**: bitmap ≈ **4 bytes/user** (32-day window) to **46 bytes/user** (365-day). Totals: 1M users ≈ 4–46 MB; 10M users ≈ 40–460 MB. Negligible in Postgres at indie scale.
- **Sources**: amplitude.com/blog/n-day-retention-for-mobile-games · gopractice.io (day-N vs rolling) · docs.mixpanel.com/docs/reports/retention (defaults to On-or-After) · adjust.com cohort retention · appsflyer.com retention-rate glossary · docs.gameanalytics.com retention · pulse.support ClickHouse bitmap retention.

### §D — Client vs server purchase truth → **DECIDED: (a) Server-only for revenue**
- **Question**: When both client and server report a purchase (or only client does), what's authoritative?
- **Decision**: **(a) Server-only is the trusted revenue record** for v1. Client purchase-context still flows via a companion event (below). Carry `transaction_id` + `original_transaction_id` + context so **(c) reconcile-by-`transaction_id`** is a drop-in later upgrade.
- **Rationale**:
  - Server-side receipt validation is universal: Apple deprecated client-parseable `verifyReceipt` (App Store Server API returns Apple-signed JWS the *backend* verifies); Google Play RTDN is notification-only + authoritative state pulled from the Play Developer API. The backend is the single trusted authority.
  - RevenueCat states it plainly: **"the client is the messenger, never the source of truth"** — purchases validated server-side directly with the stores.
  - Attribution SDKs (AppsFlyer) send only minimal client data (product/purchase id) and fetch revenue server-side; client numbers are never the revenue figure.
- **Context-dimension handling (the real tension, resolved)**: use RevenueCat's **subscriber-attributes pattern** — a **client context-companion event keyed by `transaction_id`**, carrying `player_level`, `region`, `in_game_state`, `days_since_install`, `payer_tier`, flagged non-revenue (contributes zero money). The server SDK emits the **authoritative revenue row**; the monetization rollup (product × dimension-combo) is the **server revenue row enriched by the client context row joined on `transaction_id`**. This keeps money strictly server-sourced *without* forcing the game to re-plumb all context onto the server. If the client context row never arrives, the revenue row still stands alone with reduced dimensions.
- **Dedup mechanism**: the **store-issued** transaction id (Apple `Transaction.id` / `originalID`; Google order id / `purchaseToken`), not app-generated — store-guaranteed unique across every report of the purchase; Postgres UNIQUE constraint (see §F). Store `original_transaction_id` too, because Apple's id rotates on renewal/restore.
- **Forward-compat (min v1 must carry so (c) is clean)**: `transaction_id`, `original_transaction_id`, a `source` flag (`client`/`server`) + `verified` boolean on every purchase row, client context as its own dimensions, and currency + raw amount stored separately from any normalized value.
- **Sources**: developer.apple.com App Store Server API · adapty.io IAP validation · developer.android.com Play RTDN + lifecycle · revenuecat.com implementation-responsibilities + customer-attributes · support.appsflyer.com purchase validation · developer.apple.com StoreKit Transaction · support.google.com/analytics GA4 24h purchase/refund dedup.

### §E — Redis data-loss window, flush cadence & worker ordering → **DECIDED: (a) accept-loss, no replay; N=5min; write-ahead raw file**
- **Question**: What loss is acceptable on Redis failure; do we replay from the raw file; what is the flush cadence?
- **Decision**: **(a) accept loss** of current-day live counters + in-flight queue, **no automated replay** in v1 (the raw file remains the *manual* rebuild floor). This is only safe with the three settings below.
- **Flush cadence**: **N = 5 minutes** (config, default 5). A Redis crash then loses ≤5 min of durable-result drift plus the transient-by-design live counters. Flushing is O(active game×currency×bucket) upserts (~288 cycles/day), trivial for a modest VPS and ~300× cheaper than per-event writes. 1 min buys little; 15 min widens the loss window for no load payoff — 5 min is the knee.
- **Redis persistence**: **AOF `appendonly yes` + `appendfsync everysec`, RDB snapshots also on.** BullMQ's production guide recommends AOF and *mandates* `maxmemory-policy noeviction` (+ `maxRetriesPerRequest: null`). `everysec` worst-case loses ~1 s of jobs (fsync on a background thread → write perf stays good), shrinking in-flight-queue loss from "all of Redis" to "≤1 s."
- **Worker ordering (makes SC-008 true)**: the worker MUST **append the batch to the daily raw file (fsync'd) BEFORE incrementing Redis counters / flushing**. Raw-append-first ⇒ the raw file is a *superset* of anything Postgres ever saw; a crash at worst leaves events *logged-but-not-counted* (recoverable by manual rebuild). Counter-first ⇒ a crash leaves events *counted-but-never-logged* → **unrecoverable**, breaking SC-008's promise that the day's raw file survives as a complete record.
- **Idempotent flush**: **yes — upsert absolute counter values, not `+= delta`** (`INSERT … ON CONFLICT … DO UPDATE SET value = EXCLUDED.value`). A retried/duplicated flush is a no-op. **Interacts with §F**: absolute-upsert protects the *flush path*; it does NOT stop the same *event* being counted twice into the Redis counter (offline resend) — that needs §F `event_id` dedup. Money correctness = both layers.
- **Sources**: docs.bullmq.io/guide/going-to-production (AOF, `noeviction`, `maxRetriesPerRequest`) · redis.io persistence (AOF vs RDB, `appendfsync`, "use both") · oneuptime.com write-behind cache (absolute upsert) · blog.sentry.io buffering SQL writes with Redis · medium.com/@timanovsky async counters in Postgres.

### §F — Duplicate / retried-batch dedup → **DECIDED: (a) `event_id`+24h window for events; durable `transaction_id` for purchases**
- **Question**: Offline retry may resend a batch. Dedup or tolerate double-count?
- **Decision**: generic/economy events → per-event client-generated `event_id` + **24h Redis dedup window** (tolerated rare double-count only *beyond* the window, an explicit accepted tradeoff for non-money events). Purchases → **durable dedup by `transaction_id` (Postgres UNIQUE)**, NOT a Redis window.
- **Dedup window = 24h**, matching Redis's ≤1-day transient ceiling and Segment/Stripe precedent (Segment stores ≥24h of messageIds; Stripe idempotency keys 24h; Amplitude `insert_id` is 7d but that exceeds our Redis TTL). Offline retries almost always resolve within hours, so 24h covers the realistic envelope. **Residual risk**: a retry landing >24h later double-counts a *non-money* event — acceptable at indie scale. Purchases are immune (durable path).
- **Why purchases must be durable, not windowed**: an offline purchase retry can arrive **days** later; Redis's ≤1-day TTL cannot catch it. Money-truth uniqueness must outlive transient storage.
- **Data structures**: events → Redis **SET with per-key TTL** (`SET dedup:{event_id} 1 EX 86400 NX`), ~0.4–0.6 GB/day at 10M events/day (manageable, not free). **RedisBloom** is a documented scale lever (~12–24 MB/day, 25–40× smaller) but a false positive silently *drops* a real event — **never put purchases behind a Bloom filter.** Purchases → durable `transaction_id` UNIQUE table, `ON CONFLICT DO NOTHING`.
- **Batch vs per-event**: **per-event `event_id`.** BullMQ retries the *whole job* on failure (at-least-once; idempotent processing required). A batch-level key breaks under partial processing failure (crash after counting 50/100 → whole job re-runs → either skips uncounted 51–100 or double-counts 1–50). Per-event ids make each event independently idempotent.
- **Storage-model note**: a small **durable `transaction_id` idempotency table does NOT violate "results-only"** — it stores uniqueness keys, not raw events; it is functionally part of the money-results spine. Explicitly allowed, kept lean (`transaction_id` + timestamp).
- **Sources**: amplitude.com HTTP v2 / data-mutability (`insert_id` 7d) · segment.com duplicate-data + exactly-once (messageId ≥24h) · docs.stripe.com idempotent_requests (24h) · docs.snowplow.io event-fingerprint + dedup (durable manifest) · redis.io bloom-filter (bits/element) · docs.bullmq.io retrying-failing-jobs + idempotent-jobs.

### §G — Event-time bucketing & late events → **DECIDED: (c) client-time + skew-correction; UTC; 48h grace**
- **Question**: Bucket by server-receive-time or client-event-time; how are late/offline events handled?
- **Decision**: **(c) client-event-time with skew-correction against server-receive time, plus sanity clamp/quarantine.** This is the exact model Snowplow and Amplitude ship.
- **Skew-correction (adopted, principled — not hand-wavy)**: `corrected_event_time = client_event_time + (server_received_time − client_sent_time)` (identical to Snowplow's `derived_tstamp = collector_tstamp − (dvce_sent − dvce_created)` and Amplitude's correction). **SDK must send BOTH** a per-event `client_event_time` and one per-batch `client_sent_time`; the collector stamps `server_received_time`.
- **Concrete tolerances**:
  - **Skew-correction dead-band: 60s** (Amplitude's) — under 60s of skew, use raw client time; sub-minute skew never crosses a day boundary except at midnight.
  - **Future-dated events**: clamp to server-now (Amplitude resets future timestamps to server time).
  - **Wild-skew quarantine**: when corrected time lands more than a few days outside the open window (Amplitude's absolute outer bound is 60d), quarantine to the raw file — don't fold into aggregates.
  - **Lateness / grace window: keep today + prior 48h mutable, then seal.** Ties directly to §E flush cadence; 48h absorbs virtually all offline-buffer/retry batches (§F). (Industry marker: Mixpanel real-time `/track` accepts only the last 5 days; older needs the batch `/import` path.)
  - **Beyond the window: quarantine, don't drop or clamp.** Write late-for-a-sealed-day events to the raw quarantine file (recoverable in a future backfill) but do NOT mutate the sealed aggregate. Dropping loses data; clamp-to-now corrupts both the sealed day and today.
- **Timezone**: **store corrected `event_time` as UTC epoch; "a day" is UTC for v1.** Reporting/display timezone is per-game configurable later (GA4 model: `event_timestamp` UTC, `event_date` bucketed in the configured timezone). Per-user local time is rejected — it makes cohort days non-comparable across users. UTC storage keeps day-bucketing deterministic and re-derivable, and preserves the §B immutability guarantee.
- **Residual error**: only events arriving >48h after they happened *and* belonging to a now-sealed day — a small tail for offline mobile play; it lands in quarantine, not in headline retention/economy numbers.
- **Sources**: docs.snowplow.io/docs/events/timestamps + snowplow.io blog (understanding time) · amplitude.com/blog/dont-trust-client-data (correction, 60d cutoff, future-reset) + community.amplitude.com (60s dead-band) · docs.mixpanel.com (UTC, 5-day `/track` vs `/import`) · ga4bigquery.com (UTC `event_timestamp` vs property-timezone `event_date`).

### §H — Event schema policy → **DECIDED: (c) hybrid accept-all + auto-registry; strict typed kinds**
- **Question**: Strict per-game registered event names/shapes, or schema-less accept-all?
- **Decision**: **(c) hybrid** — accept-all named events with a property bag; auto-discover names/props into a per-game catalog for the dashboard; strictly validate only the reserved typed kinds. This is the mainstream pragmatic default (Amplitude Observe, Segment Protocols, GA4 default to permissive ingest + a self-populating catalog; strict validation reserved for core/ecommerce shapes).
- **Validation boundary (precise)**:
  - **Strictly validated (does NOT count toward rollups on violation)**: the three reserved kinds — `economy` (`flow_type`/`currency`/`amount`/`reason`), `purchase` (`transaction_id`/`product`/`price`/dimensions), `session`. Mirrors Snowplow (only schema-valid events reach atomic tables) and GA4/Segment treating ecommerce/recommended events as fixed-schema.
  - **Free-form (accept any property bag, never rejected for shape)**: all other named events; name + observed property keys/types auto-registered. Mirrors GA4 custom events ("fire and they appear") and Amplitude "Unexpected" events.
  - Rule of thumb from the mature tools: **enforce the events that power built-in reports; stay permissive on everything else.**
- **Malformed handling (v1)**: **drop** unparseable / non-JSON / no-event-name events (with a counter; never crash the worker). **Quarantine to the raw file** typed-kind events missing required fields (Snowplow "failed-events bucket" pattern; the raw file *is* the dead-letter store for a solo operator — a full DLQ is overkill in v1). Reserved names (`purchase`/`economy`/`session`) always route to the strict path even if malformed.
- **Auto-registry shape (minimal, results-only-friendly)**: one row per event name — `game_id`, `event_name` (PK with game_id), `kind` (free-form|economy|purchase|session), `first_seen`/`last_seen`, `count` (approximate OK), `property_keys` (JSON `{key: observed_type}`), optional `status` (`unexpected`/`accepted`) for later Amplitude-style promotion. Derived metadata only — no raw events — so it fits results-only.
- **Guardrails**: **cap unique event names per game** (GA4 caps at 500) and drop/alert beyond it, so a buggy client emitting random names can't explode the registry; cap observed property keys per event similarly.
- **Sources**: amplitude.com/docs/data/validate-events + create-tracking-plan (Observe / schema-on-read) · segment.com/docs/protocols (permissive default, opt-in enforcement, quarantine source) · docs.snowplow.io failed-events + Iglu (strict up-front, bad-events bucket) · developers.google.com GA4 events + support.google.com (500 unique custom event names cap).

---

## 4. Reference Architecture Decisions (from brainstorm — context for `/plan`)

- **Modular monolith**: one NestJS codebase with internal modules (ingest, workers, metrics, panel). The panel is a server-rendered dashboard (Nunjucks + Tailwind + HTMX + Alpine.js + Chart.js) served from the same NestJS process — no separate front-end app. Structured so ingest can be extracted into its own service later without a rewrite. Rejected: separate services now (premature), event-sourced Postgres (the heavy model being avoided).
- **Storage split**: Redis = transient queue + hot counters (≤1 day, disposable); Postgres = user spine + result/rollup tables only; daily gzip raw files = cold backup → S3 → deleted local.
- **S3-compatible target** (MinIO / Arvan / any) so it works under network restrictions and phones home to nothing blocked.
- **Config-driven**: batch interval, cold-storage toggles, monetization dimensions (rebuild-forward), retention day targets, level-bucket boundaries, flush cadence — all config, no code changes to shift strategy.

---

## 6. Open Questions — surfaced *by* the §3 decisions (resolve during `/plan` or a follow-up clarify)

Resolving §B–§H exposed second-order questions the spec did not previously address. Each has a **default recommendation** so `/plan` can proceed without blocking; the operator can override. Grouped by origin. Status legend: **[OPEN]** = needs a call, **[LEANING]** = default proposed, confirm.

### From §B (retention)
- **§B-1 — Definition of "active" [LEANING]**: what marks a user active on a day — any event, or a qualifying **session-start** event? Adjust/GameAnalytics count ≥1 session. *Default: ≥1 `session` event sets the day-offset bit.*
- **§B-2 — Immature-cohort display [LEANING]**: a cohort whose day-N hasn't fully elapsed must render as N/A / greyed, never as a misleadingly-low number. *Default: heatmap masks cells where `today − cohort_date < offset` (an "elapsed?" mask).*
- **§B-3 — Metric labelling [LEANING]**: UI must label the figure "classic Day-N retention" (Mixpanel-style unbounded is a different number). *Default: explicit label + tooltip; benchmark against GameAnalytics/Adjust.*

### From §D (purchase truth)
- **§D-1 — Refunds / chargebacks [OPEN]**: server-only revenue means refunds arrive via App Store Server Notifications V2 / Play RTDN. Does v1 subtract them (net revenue) or ship **gross-only**? Only S2S tiers of commercial SDKs handle this. *Recommendation: gross-only in v1; carry a `refunded` flag + notification hook for v2.*
- **§D-2 — Currency normalization source of truth [OPEN]**: stores return local currency. Who owns FX conversion and the as-of date for the `price_usd` rollup? *Recommendation: store raw local amount + currency always; normalize with a config-supplied FX table stamped at purchase date; defer live FX.*
- **§D-3 — Sandbox / test purchases [LEANING]**: must be flagged and excluded from revenue. *Default: `environment` field (`prod`/`sandbox`) on every purchase; sandbox excluded from rollups.*
- **§D-4 — Player-identity ↔ store-transaction mapping [OPEN]**: Apple `appAccountToken` isn't guaranteed; how does the server tie a store transaction to the game `user_id`? *Recommendation: game passes `user_id` to the server SDK at validation time; store it on the purchase row.*
- **§D-5 — Missing client companion event [LEANING]**: if the context row never arrives, the revenue row stands alone with reduced dimensions. *Default: accept reduced-dimension purchase; do not block revenue on context.*

### From §E (Redis loss / flush)
- **§E-1 — Live-counter TTL [LEANING]**: what TTL on Redis hot counters? *Default: expire at end-of-UTC-day, aligned to the daily bucket + raw-file rotation.*
- **§E-2 — Dashboard live-vs-historical seam [OPEN]**: does the UI read today's number as Redis-live and past days as Postgres-historical, or stitch them — and does it label "last ~5 min may be provisional"? *Recommendation: today = Redis-live, sealed days = Postgres; small "provisional" note on today.*
- **§E-3 — Raw-file append durability [LEANING]**: is the raw-file append fsync'd per batch or OS-buffered? Buffered weakens the "durability floor" to ~page-cache. *Default: fsync per batch (the floor SC-008 relies on); revisit if it costs throughput.*
- **§E-4 — Flush reads absolute value [RESOLVED 2026-07-17, hardening pass]**: absolute-read confirmed, **and the blind `SET value = EXCLUDED.value` upsert is retired** — an adversarial review found it unsafe under a torn `HGETALL` racing concurrent `HINCRBY`, and after a crash+rehydrate it could clobber durable results *downward*. Replaced by a **per-class merge rule** (Foundation §3.2.1): monotonic-max (`GREATEST`) for additive counters/sums (class M), set-union for membership (class S), generation-gated atomic Lua-snapshot for mutable-down monetization/FX cells (class N — `GREATEST` would double-count the enrichment MOVE), and the existing `as_of` LWW guard for balances (class L). Rehydrate uses `HSETNX` (no double-seed) + a `seeded` marker (no half-seeded flush). Every class is a no-op on retry.

### From §F (dedup)
- **§F-1 — Dedup-window clock [LEANING]**: is the 24h TTL measured from **server-receive-time** (simple, immune to client skew) or client-event-time? *Default: server-receive-time, so §G clock skew can't shrink/extend the window.*
- **§F-2 — `transaction_id` table retention [LEANING]**: must outlive events to catch a very-late offline purchase retry. *Default: retain effectively indefinitely (it is tiny); no short prune.*
- **§F-3 — Server-SDK event ids [OPEN]**: do server-emitted events (§D) also carry `event_id`, or use a distinct trust path? *Recommendation: server SDK also stamps `event_id`; server events skip the Bloom lever (always exact).*
- **§F-4 — RedisBloom false-positive tolerance [OPEN, scale-only]**: if adopted at scale, silently dropping ~1-in-100/1000 non-money events acceptable vs the memory saving? *Recommendation: SET-with-TTL in v1; Bloom is a documented later lever, never for money events.*

### From §G (bucketing)
- **§G-1 — Future-dated single events [LEANING]**: a fast client clock on an immediately-sent single event has no batch skew to correct against. *Default: clamp to server-now; explicit rule in the SDK contract.*
- **§G-2 — DST & per-game reporting timezone [OPEN]**: if per-game display timezone is added, day boundaries shift twice a year — retention Day-N math must stay UTC internally, offset only at display. *Recommendation: UTC internal always; per-game offset display-only; document DST behaviour.*
- **§G-3 — Changing a game's timezone after data exists [RESOLVED 2026-07-17, hardening pass]**: superseded by the platform **logical day** (Foundation §4.7). The reporting offset is now *correctness-bearing* (it defines the day floor for all metrics + seals), **set-once at install** — changing it after data exists is a forward-rebuild (out of v1 scope), exactly the immutability-preserving posture this question sought. It is no longer "display-only"; the single-timezone distortion §G-2 hinted at is the reason.
- **§G-4 — SDK stamps `client_sent_time` on single-event sends [LEANING]**: skew correction needs it even on immediate one-event batches. *Default: SDK always stamps `client_sent_time`.*

### From §H (schema)
- **§H-1 — Property-type drift [OPEN]**: same property key seen as string then number. Track a type-set and flag drift, or last-write-wins? *Recommendation: store a per-key observed-type set and flag drift in the catalog; don't reject.*
- **§H-2 — Reserved-name collision [LEANING]**: a free-form event named `purchase`/`economy`/`session`. *Default: reserved names always route to the strict typed path (and quarantine if malformed); the name is claimed by the platform.*
- **§H-3 — PII in free-form props [OPEN]**: accept-all lets arbitrary keys carry PII into the catalog/rollups. *Recommendation: config-driven property denylist + optional hashing; document that free-form props are operator-trusted (solo-operator assumption).*
- **§H-4 — Catalog / property-key cardinality caps [LEANING]**: a buggy client emitting random names/keys could explode the registry. *Default: cap unique event names per game (start at GA4's 500) and observed keys per event; drop + alert beyond.*

### Cross-cutting (spans several decisions)
- **§X-1 — Manual raw-file rebuild procedure [OPEN]**: §E makes the raw file the manual rebuild floor and §G quarantines late events there, but v1 ships no rebuild tooling. Document at least the *manual* procedure (re-derive a day's aggregates from its gzip file) so "disposable but recoverable" is real, not aspirational. *Recommendation: write a runbook; automated replay stays deferred.*
- **§X-2 — Session definition & boundary [OPEN]**: §B ("active" = session) and §D (`sessions_before_purchase`, `session_id`) both depend on what starts/ends a session (inactivity timeout? explicit start/stop?). The spec references `session_id` but never defines a session. *Recommendation: SDK-managed session with a config inactivity timeout (e.g. 30 min); define before `/plan`.*

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

---

## 7. Second-Round Resolutions (2026-07-17 — SDK + hardening phase)

The design layer's operator-ratification questions (`phases/README.md` list, plus four net-new hardening questions) were resolved by a second research pass — one internet-research agent per question, locked in the §B–§H pattern (decision · rationale · sources). The **decision record** lives in each question's home document; the entries below are the research trail.

### Q4 — Upload eligibility: sealed day, not literal "yesterday" → **CONFIRMED as designed**
- **Decision**: a raw day-file is upload-eligible at **seal** (`D_end + 48 h`; the nightly run ships `run_day − 3` under the default grace). US5/SC-010's "yesterday's file" reads as "the most recent completed file". Home: [bridge 01.5 §6](phases/01.5-raw-file-contract.md) + 07 Design.
- **Why**: shipped objects are final across the industry — Kafka Connect's S3 sink uploads only rotated/closed files (commit-after-upload; retry = idempotent overwrite to the same deterministic key); GA4's BigQuery daily table lands mid-next-day and stays mutable ~72 h (longer than our 48 h seal), patchable only because BigQuery is a mutable warehouse, with an intraday table covering freshness (our Redis open-day buckets are that analog); ship-immediately systems (Firehose, Snowplow lake loaders) key objects by *arrival* time, not event time. S3-compatible objects are immutable (PUT = full replace), so ship-early forces whole-object rewrites or breaks the SC-008 superset in the object.
- **Sources**: Confluent S3 Sink Connector docs (rotation/commit) · support.google.com — [GA4] BigQuery Export · AWS S3 docs (append/immutability) · Snowplow docs (lake-loader partitioning; late-arriving data) · AWS Firehose buffering FAQs.

### Q1 — `first_seen` = first accepted **session** event → **first-session (option b), not any-event**
- **Decision**: `first_seen` = corrected UTC start of the user's first accepted `session` event; sequence A relocates from 01's front-door to 02's session path. Home: [bridge 02.5 §6](phases/02.5-activeness-spine-contract.md); Foundation §5/§9.4/§3.1 + 04 DD-1 updated.
- **Why**: every surveyed product keeps the cohort-anchor event and the return event in the same activity domain — GameAnalytics (install ≡ first-session date; "D0R is always 1.0"), Adjust (install = first app open = first session), Amplitude/Mixpanel (symmetric any-event or user-chosen), GA4 (`first_open` coincides with `session_start`). With our locked *activeness = session-start* invariant, any-event seeding was the one asymmetric config no product ships (D0 < 100 % by construction; never-sessioned users deflating every D_N against install≡first-session benchmarks). First-session makes **D0 = 100 %** an invariant and `cohort_size ≡ RETENTION_CELL(c,0)` a free integrity check.
- **Consequence**: never-sessioned users (server-only emitters, purchase-before-session) get no spine row (`no_spine_row` advisory tally; install dims → `unknown`); the **money family is spine-independent** — a payer may exist with no spine row, `first_purchase_day` may precede `first_seen`.
- **Sources**: GameAnalytics retention docs + R. Ovans "Retention" · Adjust glossary/cohorts · Amplitude retention docs + community · Mixpanel retention docs · Google Analytics Help — [GA4] auto-collected events + cohort exploration.

### Q2 — Provenance via credential class (F-3) → **RATIFIED: two-class keys, no HMAC in v1**
- **Decision**: public `sdk_key` (embeddable, auto-issued, `provenance=client`) vs secret `server_credential` (show-once, hashed, 1..N per game, `provenance=server`); prefix-typed key strings; plain bearer over TLS (no HMAC); dual-active rotation with `last_used_at` drain; scoping stops at class + game. Home: Foundation §4.5 (F-3 resolved) + §9.5; issuance/rotation lifecycle → phase 10.
- **Why**: the public/secret split is the archetypal pattern across Stripe (`pk_`/`sk_`), PostHog (`phc_`/`phx_`), RevenueCat (public SDK vs `sk_`), Segment (write key + source-type-as-trust), Amplitude, Mixpanel — all treat client keys as non-secret by design and derive capability from the secret class. GameAnalytics' HMAC-with-embedded-key is the counter-example that proves the rule: the "secret" ships in the build, so signing is tamper-deterrence, not provenance.
- **Sources**: Stripe API-keys + rotation · PostHog project/personal keys · RevenueCat auth · Segment write keys · Amplitude keys-and-tokens · Mixpanel token vs secret · GameAnalytics collection-API HMAC.

### Q3 — Payer-tier cumulative spend → **RATIFIED: lifetime, fixed thresholds; `lifetime_spend_normalized` on `PAYER_SPINE_EXT`**
- **Decision**: store lifetime cumulative normalized spend (monotonic, in the 05.5 atomic unit), tier at read time against operator-configured fixed dollar thresholds (default minnow <$10 / dolphin $10–99.99 / whale ≥$100 — the deltaDNA anchor); store the spend, never the tier. Home: [bridge 05.5 §6](phases/05.5-purchase-accept-contract.md); Foundation §1.2 + spine ledger amended.
- **Why**: the industry's canonical tier definitions are lifetime (deltaDNA: whale = ">$100 lifetime"; 54 % of whales never made a >$50 transaction — status accretes; devtodev/GameAnalytics segment by *total* spend; RevenueCat value = cumulative LTV). "Payer vs non-payer" is itself lifetime-anchored, so windowed tiers within it are incoherent; demotion is layered via RFM recency over a sticky lifetime tier (derivable from `PAYER_PERIOD_SPEND` at zero extra state). Percentile tiering rejected for the spine (unstable/nondeterministic/retroactive), kept as downstream views.
- **Ledger**: one new payer-bounded line in `metrics/README.md` (landed).
- **Sources**: deltaDNA/PocketGamer.biz · devtodev segmentation · GameAnalytics whales · Game Developer whale-spending · RevenueCat realized-LTV.

### Q5 — Money-supply trend → **RATIFIED: `ECONOMY_SUPPLY_DAY` daily balance snapshot (not cumulative flow)**
- **Decision**: snapshot the balance-derived supply level (Σ `last_known_balance` + percentiles + `n_users`) once per game×currency×day at seal, gated on `economy_depth_capture_mode`; do NOT materialize cumulative sources−sinks (that stays a query-time window function). Home: 03 Design; Foundation §5 + ER-full.
- **Why**: `BALANCE_SNAPSHOT` is upsert-latest, so the supply *level* history is capture-it-or-lose-it — no query-time recompute is possible. Cumulated flow is an index of change, not a level (starts at zero at instrumentation start, absorbs every residual); EVE Online's MER keeps Money-Supply (snapshotted level) and Sinks/Faucets (flow) as *separate* charts precisely because they diverged 9 % for three months. Overlaying both lines makes divergence diagnostic of untracked/spoofed flow.
- **Sources**: EVE Online MER + `money_supply.csv` · The Nosy Gamer Nov-2025 analysis · Roblox economy dashboard · NetEase GDC 2020 · Postgres window-function practice.

### Q6 — Monetization residual display drift → **RATIFIED: accept-with-reconciliation, promoted to normative**
- **Decision**: accept ≤ one-flush-window display drift on live cells under compound crash+Redis-loss (sealed = exact); the reconciliation check is now a **required** job — periodic on open days, mandatory at seal (Σ cell revenue vs idempotency day sum; rebuild `PAYER_DAY` exactly, repair `MONETIZATION_CELL` via raw replay or an all-`unknown` delta cell; a day seals only after the check passes). Reject transactional outbox + Postgres-computed live views. Home: 05 Design.
- **Why**: "live is provisional, finalized is exact" is the standard analytics contract — GA4 marks intraday data mutable 24–48 h (revenue included, "not an SLA"); Stripe reconciles its immutable ledger over a multi-day window; Lambda doctrine names the speed layer approximate and the batch layer corrective. Our worst case (~5 min of one game's purchases, corrected ≤48 h) is inside every norm; an outbox would protect only a display cache whose truth is already durable at 6b + the write-ahead raw file.
- **Sources**: GA4 data-freshness docs · Stripe Ledger blog · Lambda architecture · microservices.io / AWS transactional-outbox guidance.

### Q7 — Right-to-erasure (GDPR/CCPA) → **DESIGNED: four-tier posture** (normative in `00.5-ops-envelope.md`)
- **Decision**: (a) hard-delete the spine family + scrub `user_id` from `ACTIVE_USER_DAY`/`PAYER_DAY` membership sets; **detach not delete** `PURCHASE_IDEMPOTENCY` (`user_id` tombstoned, money fields kept). (b) Leave aggregated day cells untouched, never recompute. (c) Raw S3 files → retention-bounded expiry (`raw_retention_days`, default 90) + a rebuild-filter `ERASURE_LEDGER` ("put beyond use"); optional offline strict-rewrite tool; crypto-shredding rejected for v1. (d) Redis self-erases by TTL behind a wait-for-seal gate. SLA ≤ 30 days (typically ≤ 4). New entity `ERASURE_LEDGER` (subject stored as per-game keyed hash, not plaintext `user_id`).
- **Why**: GDPR applies only to personal data — Recital 26 excludes anonymous/aggregate stats; Art. 17(3)(d)+89(1)+Art. 11 protect immutable statistical aggregates and disclaim any duty to re-identify. The spine is the whole personal-data surface and is tiny by design (the payoff of results-only). Purchases keep independent legal-retention footing (Art. 17(3)(b)). Rewriting immutable S3 objects on the hot path is the known-expensive anti-pattern (PostHog batches deletes to weekends; Snowplow R2F is an offline Spark job); retention-expiry + ledger-refilter-on-rebuild is the regulator-accepted backup posture (ICO "put beyond use"; Matomo's raw-purge-keep-reports model). Aggregate/projection drift after erasure is now a documented feature of the §1.3 recovery lever (spine re-scans reconcile forward).
- **Sources**: Plausible/Matomo/PostHog/Snowplow/GA4 erasure docs · GDPR Recital 26 + Art. 11/17 · IAPP Art. 11 · AWS S3 lifecycle · erasure-timeframe references.

### Q8 — Missing FX rate → **RATIFIED: as-of lookup + park-unconverted (a primary, c terminal, never b)**
- **Decision**: `fx_rate(currency, day)` = most recent row with `rate_date ≤ day`, valid iff within `fx_staleness_max_days` (new knob, default 7); carry-forward is normal (ECB feeds skip weekends/holidays — ~2/7 days have no row). Within-cap stale → normalize + `fx_stale_rate_used` tally; missing/over-cap → **park unconverted** (0 to `rev`, `fx_unconverted` tally; `cnt`/`loc`/payer set unaffected — money never blocked). Self-heals before seal via the existing `loc`-recompute; sealed days frozen. Rate source = operator-owned `fx_table`; optional bundled ECB/Frankfurter fetcher writes into it, never a pipeline dependency. Home: 05 Design (+ `05.5` `normalized_amount` may be 0); metrics 04 §D-2 closed.
- **Why**: carry-forward is universal because daily-feed gaps are routine (ECB business-days-only; Frankfurter returns nearest-prior by design); accounting norms bless it (IAS 21 approximating rates; ASC 830-20-30-2 "first subsequent rate"). No surveyed product holds/blocks money on a missing rate (RevenueCat/GameAnalytics best-effort convert; Stripe converts-then-reconciles); the 1:1 fallback (Firefly III) is the cautionary anti-pattern. Hold-and-retry (b) contradicts never-block-money and fights the 48 h seal.
- **Sources**: RevenueCat display-currency · ECB reference rates + Frankfurter · Apple/Google payout FX · Stripe multi-currency RevRec · Kill Bill currency plugin · Firefly III (anti-pattern) · PwC ASC 830 · IAS 21 · exchangerate.host key-change lesson.

### Q9 — Envelope/wire versioning → **LOCKED: `/v1/events` path + batch `v` + additive-only-forever**
- **Decision**: versioned path `/v1/events` (transport contract, expected never to bump) + explicit integer batch `v` (absent ⇒ 1; primary job is provenance — stamped on every routed record + raw append) + mandatory `sdk {name,version}` descriptor. Additive-only within wire v1 permanently (nothing removed/renamed/re-typed; `kind` is an open enum; unrecognized kind → quarantine `unknown_kind`, never coerce to `generic`); unknown top-level fields ignored-and-preserved; unknown `v` → 2xx-ack + quarantine. Wire v1 accepted for the life of the platform; any v2 is a new path with a normalizing adapter. SDK semver decoupled from wire version. Home: Foundation §1.1 + §9.7; consumed by 01, 08, 09, bridge 01.5.
- **Why**: nobody in the space bumps wire majors — Segment `/v1` since ~2013, Sentry protocol 7 since 2013 (with skip-and-retain forward-compat, treated as a bug when violated), OTLP add-only stability, GA4 MP 2xx-always + a *new* endpoint for "v2". An explicit `v` is worth one integer because our envelopes are a persisted rebuild floor (SC-008), unlike Sentry/Segment's transient wire.
- **Sources**: Sentry envelopes + protocol-7 + client-reports docs · OTLP spec + proto README · Segment HTTP API · Amplitude HTTP v2 + community · GA4 Measurement Protocol reference · mobile-API-versioning norms.

### Q10 — Open-source license + npm publishing → **DECIDED: Apache-2.0 platform / MIT SDKs; trusted publishing + provenance + changesets**
- **Decision**: platform (ingest/workers/dashboard) = **Apache-2.0** (patent grant + no separate CLA); SDK packages = **MIT** per-package override (embeddable, GPL-2.0-compatible, adoption norm). npm: **trusted publishing (OIDC) from GitHub Actions** (no `NPM_TOKEN`), automatic **provenance attestations**, `publishConfig.access=public` on scoped packages, **changesets** release flow, 2FA on accounts. Home: SDK specs 08/09 packaging sections.
- **Why**: a platform/SDK license split is the dominant peer pattern (Plausible AGPL/MIT tracker, Matomo GPL/BSD tracker, Sentry FSL/MIT SDKs, Aptabase AGPL/MIT SDKs — 6 of 8 peers split; **no peer puts copyleft or Apache-2.0 on an embeddable SDK**). Apache-2.0 gives the express patent grant enterprises want; MIT SDKs maximize embed-adoption and stay GPL-2.0-compatible (Sentry's stated reason). Trusted publishing is GA since 2025-07-31 and the 2025 token crackdown makes token-CI actively painful.
- **Sources**: Sentry licensing · Plausible/Matomo/PostHog/Countly/OpenReplay/Aptabase repos + license docs · choosealicense/FOSSA Apache-2.0 patent-grant · npm trusted-publishing + provenance docs · GitHub Changelog (OIDC GA; token revocation) · Changesets.

---

## 8. Adversarial Hardening Pass (2026-07-17 — post-design review)

After Q1–Q10 locked the design layer, a multi-agent **adversarial review** (four parallel research agents — streaming/ingestion, metric-correctness, client/server SDK, security/ops/GDPR — each sourced against industry practice + papers, plus an internal-consistency audit) surfaced ~35 findings the design missed. Two hard problems were resolved by dedicated design agents. The decision records live in the phase specs; this is the research trail.

### Root causes (two, cross-cutting)
- **UTC-as-correctness, not display.** For a single-timezone player base (the operator, GMT+3:30), bucketing every metric on the UTC day systematically misattributes the local 00:00→offset band to the previous UTC day — devtodev measured D1 shifting 4–5 pp on a ~30% base (13–17% relative), one-directional (does not average out). Resolution: a **platform logical day** (Foundation §4.7), `logical_day(t)=utc_day(t+reporting_offset)`, single timezone set-once at install, applied to all metrics + seals. Option B (24h-from-install) was verified results-only-safe but rejected (changes the locked classic-Day-N definition, fixes only retention). *Sources: devtodev calendar-vs-hours; Amplitude retention time.*
- **NULL/missing treated as zero.** Drove the FX-parked whale mis-tier (a $480 whale reading "minnow" when purchases were unconvertible), the empty-denominator sink-ratio, and the dormant-holder money-supply undercount. Resolution: abstain-not-deflate (`has_unconverted_spend` → tier `indeterminate`), N/A + low-volume guards, coverage-% labeling.

### Data-corruption / durability
- **Flush torn-read + downward clobber → per-class flush policy** (Foundation §3.2.1; closes §E-4). Blind `SET=EXCLUDED` retired for M/N/S/L classes. *Sources: Redis Lua atomicity / race-condition docs; lost-update / write-behind-cache references.*
- **No Postgres backup/DR** (the "must not lose" invariant had no mechanism; raw S3 files are not a DB backup) → mandated PITR (pgbackrest/barman) to the S3 target, tested restore, RPO/RTO (00.5 §8). *Sources: GitLab 2017 DB-outage postmortem; PostgreSQL DR guides.*
- **Server NTP step corrupts skew + seal boundary** → mandatory slewing NTP + sanity clamp + monotonicity alarm (Foundation §4.2). *Sources: Cloudflare leap-second outage; monotonic-clock references.*
- **gzip-append truncation / multi-member silent-drop** → length-prefixed framed members, multi-member-safe rebuild, seal-time decode-verify (bridge 01.5 §4).
- **BullMQ stalled-job double-count** (crash between raw-append and dedup-claim) → claim the dedup marker in the same recovery unit before any counter (Foundation §3.1 step 6).

### Feature-breaking / metric bias
- **transaction_id client↔server join silently fails** (StoreKit/Play id semantics + async availability) — would empty every segmented-monetization dimension in production → client mints `purchase_attempt_id`, threads it through the store call (`appAccountToken`/`obfuscatedAccountId`), server relays it on the revenue row; join on it (08/09/05). *Sources: StoreKit 2 originalID / Ask-to-Buy .pending; Play purchaseToken vs orderId.*
- **Session-end lost on tab close** inflates every session duration → sendBeacon on visibilitychange/pagehide, reconcile backstop, timeout-as-boundary-not-fabricated-end (02/08). *Sources: sendBeacon reliability benchmarks; MDN.*
- **Small-cohort + survivorship + Simpson's** retention/monetization biases → min-cohort mask, fixed-mature-set averaging, unknown-share Simpson warning (04/05/06). *Sources: MeasuringU small-n; retention-led-growth survivor bias; analytics-toolkit Simpson.*
- **HLL lever contradicted "never HLL for retention"** → lever scoped count-only, forbidden for membership-bearing reads (Foundation §9.2).

### Security / privacy completeness (00.5 §9, phase 10)
- Reversible secrets plaintext in Postgres → envelope-encrypt with out-of-DB master key (also makes the erasure-ledger keyed hash lawful). TLS assumed→normative (+ Iran ACME/DNS-01 guidance). Public-key data-poisoning → client-provenance metrics labeled best-effort + Origin check + graceful rate-cap. Operator account → lockout + MFA + enforced viewer/admin. PII default-allow→default-deny + value scrubber. GDPR Art.15/20 access built (was erasure-only). Docker supply chain under sanctions → digest-pinned images + offline bundle. *Sources: PostgreSQL encryption docs; ICO put-beyond-use; GA4/PostHog public-key abuse; IAPP Art.11; LE Iran cert threads; npm provenance-not-sufficient (Shai-Hulud/TanStack).*

### Residual v1 defers (documented, non-blocking)
Full anon↔user merge (edge now captured); automated raw-rebuild tool (procedure specified, 01.5 §5.1); Redis HA replica+Sentinel (single-Redis availability SPOF named, 00.5 §8); DST-aware multi-timezone (single fixed offset assumed); refunds net-revenue (gross-only + hook).
