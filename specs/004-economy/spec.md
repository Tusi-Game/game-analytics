# Economy (Sink / Source) — US2

**Part of:** [001-analytics-platform](../001-analytics-platform/spec.md)
**Story:** US2 (P2 — the headline differentiator) · **Reserved kind owned:** `economy` · **Spec:** US2, FR-012/013/014, SC-004 · **Status:** Draft
**Depends on:** [002-foundation-ingest](../002-foundation-ingest/spec.md) (ingest substrate). References [003-sessions](../003-sessions/spec.md) for `session_id` provenance and the server-SDK trust path (shared with [006-monetization](../006-monetization/spec.md)).

> The `## Design` layer for this story lives in [design.md](./design.md). This spec is the requirement/story/calculation/data-shape frame; the design doc is the ER / Redis / worker / API realization over the shared [foundation](../001-analytics-platform/foundation.md).

---

## 1. Story understanding

**The story.** The developer sends currency-flow events — currency granted = **source/faucet**, currency spent = **sink/drain** — and sees, per game per currency over time, total sources vs sinks, net flow, sink ratio, the biggest faucets and biggest drains by reason, and how deep players' balances are.

**The question it answers.** *Is this game's economy healthy, or is it inflating?* For each virtual currency: how much is being created vs destroyed, which mechanics are the biggest faucets/drains, and how much currency players are sitting on. This is the feature no surveyed self-hostable tool offers first-class — the primary reason to build (the headline differentiator, US2, FR-012/013/014).

**Definition.** An **economy event** is a single currency-flow record classified as either a **source** (currency created and granted to the player — quest reward, daily bonus, loot, PvP win, passive generator) or a **sink** (currency permanently removed — shop purchase, upgrade, crafting, repair, cosmetic, time-skip, consumable). Per game × currency × UTC day we define, from the stream of valid economy events:

- **Total sources** = Σ `amount` over events where `flow_type = source`.
- **Total sinks** = Σ `amount` over events where `flow_type = sink`.
- **Net flow** = Total sources − Total sinks (persistently positive ⇒ inflation risk).
- **Sink ratio** = Total sinks / Total sources (healthy live economies steer ≈ 1.0; slightly faucet-positive ⇒ a sense of progression).
- **Per-reason breakdown** = the same source/sink totals partitioned by `reason`, yielding a ranked **top-faucet** list (sources by reason) and **top-drain** list (sinks by reason).
- **Currency depth / money supply** = the distribution of players' current balances for a currency (from `balance_after`), summarized as total held + percentiles.

**What it means for the operator.** A standalone economy dashboard: net flow persistently positive ⇒ inflation risk; sink ratio ≈ 1.0 ⇒ healthy balanced create/destroy; the top-faucet/top-drain lists say *which mechanic* to tune. Currencies are tracked **independently** — gold, gems, energy each inflate on their own curve; **no cross-currency total** (no FX between virtual currencies in v1).

**Chosen measure: flow, not balance-diff.** We sum per-event signed magnitudes into daily source/sink totals. Rejected:

- **Balance-diff inference** (derive flow by diffing successive `balance_after` values) — requires per-user ordered balance history, impossible under results-only storage (Foundation §E) without raw re-scan, and blind to *why* currency moved (no `reason`).
- **Net-only tracking** (store only net flow, not gross source/sink) — cannot produce sink ratio or the faucet/drain breakdown, the whole point of the metric.

Gross source and gross sink are the irreducible measures; everything else derives from them.

**Trust boundary.** Economy events are spoofable when client-sent — a modified client can inflate faucets or hide sinks. Two tiers, both accepted into the same aggregates but distinguishable:

- **Client SDK** economy events: convenience path for currency flows the server never sees (purely client-simulated economies, cosmetic sinks). Accepted, but inherently untrusted.
- **Server SDK** economy events (FR-007): the **trusted path** for server-granted / server-debited currency, where economy integrity matters (real-money-adjacent grants, anti-cheat-sensitive faucets). The server SDK shares the same ingest contract and the same `economy` typed kind.

A `client`/`server` provenance flag should be derivable per economy event (mirrors the purchase flag) so a dashboard can show trusted-only totals. Which flows a game routes through the server SDK is the game's decision; the platform records provenance and does not itself re-validate currency math in v1.

---

## 2. How it is calculated

**Time-bucketing.** The platform **logical day** (Foundation §4.7 — `utc_day(corrected + reporting_offset)`, single platform timezone; every "UTC day" below reads as the logical day), keyed on **skew-corrected client-event-time** (`corrected = client_event_time + (server_received_time − client_sent_time)`). A day is mutable 48 h then seals; economy events for a sealed day are quarantined, never folded in (Foundation §G).

**Grain.** Base = **game × currency × UTC-day × reason × flow_type** (a source-total and a sink-total at each). Headline figures (total source, total sink, net flow, sink ratio) are the reason-collapsed rollup of that grain. Optional secondary grain adds player-context dimensions (level bucket, region) where present — same measures, sliced.

**Formulas (per game × currency × day unless a segment is named):**

```
total_source        = Σ amount           where flow_type = source
total_sink          = Σ amount           where flow_type = sink
net_flow            = total_source − total_sink
sink_ratio          = total_sink / total_source          (undefined / N/A if total_source = 0)
per_reason_source[r]= Σ amount           where flow_type = source AND reason = r
per_reason_sink[r]  = Σ amount           where flow_type = sink   AND reason = r
top_faucets         = per_reason_source sorted desc, take economy_top_n_reasons
top_drains          = per_reason_sink   sorted desc, take economy_top_n_reasons
```

Currency depth (per game × currency, point-in-time, not per-day-summed):

```
money_supply(cur)   = Σ over users of (last-known balance_after for cur)   (point-in-time)
depth_pXX(cur)      = percentile XX of the per-user last-known balances
```

### Worked example — one game, one UTC day (2026-07-17), two currencies, multiple reasons

*Raw valid economy events that day:*

| user | flow | currency | amount | reason |
|---|---|---|---|---|
| u1 | source | gold | 500 | quest_reward |
| u2 | source | gold | 300 | quest_reward |
| u1 | source | gold | 200 | daily_bonus |
| u3 | source | gold | 1000 | pvp_win |
| u1 | sink | gold | 400 | shop_purchase:sword |
| u2 | sink | gold | 250 | upgrade:barracks |
| u3 | sink | gold | 150 | repair |
| u1 | source | gems | 50 | daily_bonus |
| u2 | sink | gems | 80 | shop_purchase:skin |
| u3 | sink | gems | 20 | time_skip |

**Gold:**
- total_source = 500 + 300 + 200 + 1000 = **2000**
- total_sink = 400 + 250 + 150 = **800**
- net_flow = 2000 − 800 = **+1200**
- sink_ratio = 800 / 2000 = **0.40**
- per-reason sources: quest_reward 800, pvp_win 1000, daily_bonus 200 → **top faucet = pvp_win (1000)**
- per-reason sinks: shop_purchase:sword 400, upgrade:barracks 250, repair 150 → **top drain = shop_purchase:sword (400)**

**Gems:**
- total_source = **50**
- total_sink = 80 + 20 = **100**
- net_flow = 50 − 100 = **−50**
- sink_ratio = 100 / 50 = **2.00**
- top faucet = daily_bonus (50); top drain = shop_purchase:skin (80)

**Health interpretation.** Currencies are read **independently**. **Gold** is strongly faucet-positive: net +1200/day, sink ratio 0.40 — only 40% of created gold is being drained, so gold supply is inflating; the dominant faucet (pvp_win) is out-emitting every sink. Left unchecked this erodes gold's value (players hoard, shop prices feel trivial). Action: add or strengthen a gold sink, or throttle pvp_win. **Gems**, the opposite: net −50, sink ratio 2.00 — players are spending gems faster than they earn them, draining reserves; sustainable only if there's an off-flow premium/purchase source of gems not captured here, otherwise gems become scarce and stall spending. A **sink ratio ≈ 1.0** on a currency is the healthy target (balanced create/destroy, controlled money supply); this game is out of balance on both currencies in opposite directions — exactly the signal US2's dashboard exists to surface.

**Currency depth (worked, gold, same game).** Suppose last-known gold balances across all users are u1=1300, u2=800, u3=2200 → money_supply(gold) = **4300**; median depth = **1300**. Rising money_supply day-over-day is the accumulation signal that corroborates the positive net-flow reading above.

**Immature / partial-window handling.** The **current UTC day** (and anything inside the 48 h grace) is **provisional** — economy totals may still grow as late events fold in; the dashboard marks today's figures provisional (Foundation §E-2). `sink_ratio` with `total_source = 0` renders **N/A**, never 0 or ∞. Depth for a day is only available if `economy_depth_capture_mode` was enabled during that day (see §4).

---

## 3. Data needed (input)

Economy is a **reserved, strictly-validated typed kind** (`kind = economy`, Foundation §H). It rides the canonical envelope (`game_id`, `user_id`/`anon_id`, `session_id`, `event_id`, `client_event_time`, `client_sent_time`, `server_received_time`, `props`); the fields below are the economy-specific payload, not a re-definition of the envelope.

**Required payload fields** (a missing/invalid one → quarantine to raw, never silently dropped — see §6):

| Field | Meaning | Source of truth |
|---|---|---|
| `flow_type` | `source` or `sink` — nothing else valid. | Emitter (client or server SDK) |
| `currency_type` | Currency identifier (e.g. `gold`, `gems`, `energy`). Free-form string, per-game namespace; each tracked independently. | Emitter |
| `amount` | Positive magnitude of currency moved. Direction is carried by `flow_type`, **never** by sign — `amount` is always > 0. | Emitter |
| `reason` / `category` | Why the flow happened (`quest_reward`, `daily_bonus`, `shop_purchase:sword`, `upgrade:barracks`, …). Drives the faucet/drain breakdown. | Emitter |

**Optional payload fields:**

| Field | Meaning | Source of truth |
|---|---|---|
| `balance_after` | Player's balance of `currency_type` immediately after this flow. Feeds currency depth / money supply. Omitting it does not invalidate the event; it only removes that event from depth computation. | Emitter (client-observed unless server-authoritative) |
| player context (`player_level`→`level_bucket`, `region`, `days_since_install`, `is_payer`, optional `in_game_state`) | Purchase-time / grant-time context for segmentation. Read from `props` or promoted dimensions. | Emitter |

**Provenance.** A `client`/`server` `source` flag should ride each economy event (mirrors the purchase flag in Foundation §D) so trusted-only totals are derivable. Adoption is via the shared envelope call in Foundation §F-3.

---

## 4. Data stored for longer-run processing

**Primary result shape.** Per **game × currency_type × UTC day × reason × flow_type**, a **running summed amount**. From this single grain everything in §2 is derivable: collapse `reason` for headline source/sink totals → net flow and sink ratio; keep `reason` for the faucet/drain breakdown. Phrased as the constraint: *per game × currency × day × reason, we must maintain a source-amount total and a sink-amount total, incrementally accumulated as events arrive.* Everything in §2 (except depth) derives from this one grain.

**Segmented result shape (optional, where context present).** Per **game × currency × day × segment-key (level_bucket, region) × reason × flow_type**, the same source/sink totals — so economy can be sliced by player context. This multiplies grain cardinality by the segment fan-out; kept bounded by the level-bucket config and by only materializing segments actually observed. If a segment dimension is absent on an event, that event contributes only to the unsegmented grain.

**Currency-depth shape (per-user spine touch, minimal).** Money supply / depth needs a *current* balance per user per currency — a snapshot, not history. To satisfy this **without raw re-scan**, capture at definition level a **last-known balance per (game, user, currency)**: each valid economy event carrying `balance_after` overwrites that user's last-known balance for that currency (last-writer-by-corrected-event-time wins). Money supply = Σ of these last-known balances; depth percentiles = distribution over them. This is an *upsert-latest* per user×currency, **not** an append log — the minimal spine extension the depth metric requires, justified because there is no other results-only way to know current balances. Only when `economy_depth_capture_mode` is on. Alternative considered and deferrable: a **periodic distribution snapshot** (histogram of balances captured at day-seal) instead of live last-known — cheaper on the spine but coarser; recommended default is `last_known_balance`. Either way, **no per-event balance history is ever stored.**

**Per-user spine.** Beyond the shared spine (`first_seen`, `active_days_bitmap`), economy adds *at most* the optional **last-known balance per user × currency** above, only when depth capture is on. The core source/sink/net/ratio/breakdown metrics need **zero** per-user state — pure per-day aggregate accumulation.

**Results-only confirmation.** All of §2 except depth is computable purely from incrementally-accumulated per-(game×currency×day×reason×flow) totals — no raw re-scan, satisfying the results-only constraint (FR-010). Net flow and sink ratio are arithmetic over two stored totals. Depth is computable from the minimal last-known-balance spine, also without raw re-scan. **No red flag.** ✓ (No DDL, column types, or Redis keys specified here by design — those are design/plan choices; see [design.md](./design.md).)

---

## 5. Data-structure thinking — Redis & database

*Conceptual shapes only. (Concrete key layouts, DDL, and worker layout are in [design.md](./design.md).)*

**Redis (transient, hot).**
- **Today's economy accumulators** — per game × currency × day × reason × flow: running summed amounts. Headline totals are the reason-collapsed read. Hot, lost on crash (accepted; ≤ 5 min drift + today).
- **Today's segmented accumulators** — the same, keyed with segment values, for observed segments only.
- **Last-known balance map** (if depth on) — per user × currency, upsert-latest.
- **The 24 h dedup window** — shared; economy dedups by `event_id` + 24 h.

**Database (durable, results-only).**
- **Economy flow results** — durable per game × currency × sealed-day × reason × flow summed totals; net/ratio/breakdown are reads over these.
- **Segmented economy results** — the same with segment keys, bounded.
- **Money-supply / depth snapshot** — the durable last-known-balance distribution per game × currency (if depth on).

**The bridge.** Hot accumulators flush to durable results on the cadence (idempotent absolute upsert — a retried flush is a no-op). Note the residual: absolute-upsert protects the *flush*, but a within-24 h retry is caught by `event_id` dedup; a retry landing >24 h later double-counts a flow (accepted indie-scale tradeoff for non-money events — economy is not money).

---

## 6. Edge cases & failure modes

- **Invalid economy event → quarantine (Foundation §H, strict typed kind).** An economy event is **valid** iff it has `kind = economy`, a `flow_type` ∈ {`source`,`sink`}, a non-empty `currency_type`, a numeric `amount > 0`, and a non-empty `reason`. Any missing/malformed required field → the event is **quarantined to the raw file** (the dead-letter floor), **not** counted toward any economy total and **not** silently dropped. Specifically quarantined: unknown/absent `flow_type`; negative, zero, non-numeric, or absent `amount`; absent `currency_type` or `reason`. A free-form event merely *named* `economy` also routes to this strict path (Foundation §H-2 reserved-name collision) and quarantines if it doesn't satisfy the shape. Nameless/unparseable events are dropped-with-counter, never reaching this path.
- **Dedup (Foundation §F).** Economy is a non-money typed kind → deduped by **`event_id` + 24 h window**, measured on server-receive-time (Foundation §F-1). A retried batch within 24 h is idempotently skipped; a retry landing >24 h later double-counts the flow into that day's source/sink total — an **accepted indie-scale tradeoff** for non-money events (unlike purchases, which are durably deduped). Note: absolute-upsert flush (Foundation §E) protects the flush path but does *not* stop a re-counted event — `event_id` dedup is the only guard, hence economy totals inherit §F's residual risk.
- **Amount sign convention.** Direction is carried solely by `flow_type`; `amount` is always a positive magnitude. A negative `amount` is treated as malformed → quarantine (not "auto-flipped to the other flow_type"), keeping validation unambiguous.
- **Late / sealed-day events (Foundation §G).** An economy event whose corrected time lands in a **sealed** day (>48 h old) is quarantined to the raw file, **never** folded into the sealed source/sink total — preserving day immutability. It is recoverable only via the manual raw-file rebuild (Foundation §X-1). This means a burst of offline-buffered currency flows returning after 48 h will be absent from headline totals but present in quarantine.
- **Clock skew (Foundation §G).** Bucketing uses skew-corrected client time; under 60 s skew the raw client clock is trusted; future-dated single events (no batch skew reference) clamp to server-now (Foundation §G-1) — so a fast-clocked client can't push a flow into tomorrow's economy bucket.
- **Redis loss (Foundation §E).** Economy hot counters are transient; a Redis loss forfeits at most the current-day, not-yet-flushed source/sink increments (≤ 5 min drift + today's live counters). Durable results (flushed ≤ 5 min ago) and the **complete** raw file (write-ahead append *before* counter update) survive — so no economy event is ever counted-but-unlogged (SC-008). Recovery of the lost slice is via manual rebuild from the raw file.
- **Missing `balance_after`.** Depth is best-effort: events without `balance_after` simply don't update last-known balance. If a user *never* emits `balance_after`, they're absent from money-supply/depth (an under-count of depth, not of source/sink totals). Depth figures should be labelled as covering only balance-reporting users.
- **Spoofed client economy.** A modified client can inflate faucets / suppress sinks. The platform does not detect this in v1; the mitigation is the **server-SDK trusted path** for flows that matter (§1) plus derivable client/server provenance so a dashboard can show trusted-only totals. Trust is a routing decision by the game, not a validation the platform performs.
- **Unknown currency proliferation.** With the default empty allowlist, a buggy client emitting random `currency_type` strings inflates grain cardinality. Bounded by the shared per-game event-name cap posture (Foundation §H-4) applied analogously to currencies; `economy_currency_allowlist` is the explicit lever if it becomes a problem.

---

## 7. Configurations

| Knob | Default | Range / values | Forward / retro |
|---|---|---|---|
| `economy_top_n_reasons` | 10 | 1–100 | **Retroactive** — display-time ranking/truncation over stored per-reason totals; changing it re-renders from existing stored per-reason totals, no re-bucketing. |
| `economy_ratio_min_events` | 100 | 1–100000 | **Display-only** — below this per-leg event count, `sink_ratio` is annotated low-volume/unreliable (§2 read-model). Mutates no stored cell. |
| `economy_currency_allowlist` | empty = accept all | set of currency strings, or empty | **Forward-only** — enabling rejection leaves past aggregates untouched (a formerly-accepted currency's sealed days stay); default accepts + auto-registers any currency, matching Foundation §H accept-all posture. |
| `economy_depth_capture_mode` | `last_known_balance` | `last_known_balance` / `off` | **Forward-only** — depth is only computable for days processed while enabled (see §4); turning it on does not backfill sealed days. Default keeps the per-user spine zero-cost until an operator needs money-supply/depth. |
| `level_bucket_boundaries` (shared, FR-027) | platform default | ascending level thresholds | **Forward-only** — re-bucketing sealed segmented aggregates would violate Foundation §G/§B immutability; applies to new days only. |
| `per_game_reporting_timezone_offset` (shared, FR-027) | UTC | offset | **Display-only** — never re-buckets stored aggregates (Foundation §G-3); economy days remain UTC internally. |

**Inherited globals:** Postgres flush cadence (5 min, Foundation §E), dedup window (24 h, Foundation §F), late-event grace / day-seal (48 h, Foundation §G), per-game event-name cap (500, Foundation §H). Rule: anything touching sealed aggregates is forward-only; the two retroactive/display knobs above only re-read or re-rank already-stored results.

> **Note on the `economy_depth_capture_mode` default.** The deeper metric sheet's original leaning was `off` (keep the per-user spine zero-cost by default); the ratified story-level default is `last_known_balance`. Depth is only computable for days processed while enabled either way; turning it on does not backfill sealed days.

---

## 8. Open questions

- **Currency-depth capture mechanism [RESOLVED — Q, 2026-07-17].** Live **last-known balance per user × currency** (upsert-latest) is the default (§4). The day-seal distribution snapshot is a deferrable cheaper-spine alternative if the per-user×currency balance map grows uncomfortable.
- **`balance_after` trust / negative-balance handling [RESOLVED via LWW design].** `balance_after` is client-observed unless server-authoritative and can be spoofed or arrive out of order; a stale event could overwrite a newer balance if event-time ordering is imperfect. Resolution: last-writer-by-corrected-event-time wins (guarded LWW, see [design.md](./design.md)); clamp implausible negatives out of depth; treat depth as advisory, not trusted, unless server-sourced.
- **Economy `source` provenance flag [RESOLVED — Q2/F-3, 2026-07-17].** Every economy event carries a `client`/`server` provenance, **derived at ingest from the authenticating credential class** (Foundation §4.5; public `sdk_key` = client, secret `server_credential` = server), not a body flag — so trusted-only economy views are derivable.
- **Money-supply trend [RESOLVED — Q5, 2026-07-17].** §2's "rising money supply day-over-day" health read needs a supply-*level* history, which the upsert-latest balance map destroys daily; ratified as a daily balance-derived snapshot (`ECONOMY_SUPPLY_DAY`) — see [design.md](./design.md). Cumulative sources−sinks stays a query-time window function, not stored.
- **Session dependency.** Economy events reference `session_id` from the envelope; economy itself imposes no new session semantics — it inherits the locked SDK-managed session definition ([003-sessions](../003-sessions/spec.md)). Per-user session analysis (currency-per-session) is unavailable under results-only (no per-user session history). **Default: no per-session economy rollup in v1.**
- **Segment cardinality bound [RESOLVED — independent axes].** Segmented economy (currency × day × level_bucket × region × reason × flow) can fan out. Resolution: only materialize observed segments; independent per-dim axes (a *sum* of small axes, never the level×region cross-product); if cardinality bites, restrict segmentation to headline totals (drop per-reason within segment). See [design.md](./design.md).
- **PII in `reason` / context (Foundation §H-3).** `reason` and promoted context are operator-authored strings and could carry PII. Recommendation: inherit the platform-wide config denylist / hashing (Foundation §H-3); solo-operator-trusted in v1.
- **Timezone-change on economy history (Foundation §G-3).** A per-game reporting-timezone change must stay **display-only** and never re-bucket sealed economy days. Recommendation: UTC internal always; offset at display; a true timezone change is a rebuild-forward, like monetization dimensions.

---

## Cross-references

- Shares the **server-SDK trusted path** with [006-monetization](../006-monetization/spec.md). Consumes `session_id` from the envelope but imposes no session semantics; no per-session economy rollup in v1 (results-only).
- Shared substrate: [foundation](../001-analytics-platform/foundation.md), umbrella [spec](../001-analytics-platform/spec.md), consolidated model [ER-full.md](../001-analytics-platform/ER-full.md).
