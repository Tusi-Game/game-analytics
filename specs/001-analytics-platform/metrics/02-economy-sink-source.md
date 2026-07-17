# Metric Spec Sheet: Economy (Sink / Source)

**Feature**: 001-analytics-platform · **Phase**: research/specify · **Status**: Draft
**Depends on**: §A (economy domain), §H (typed-kind strict validation), §G (event-time / UTC day-seal), §F (dedup), §E (Redis loss / 5-min flush), Sessions sheet (`session_id` provenance), §D (trust boundary / server SDK). Sibling: Monetization sheet (shares the server-SDK trust path, distinct rollups).

## 1. Purpose & Definition

**Question answered**: Is this game's economy healthy, or is it inflating? For each virtual currency, how much is being *created* (faucets/sources) versus *destroyed* (sinks/drains) over time, which specific mechanics are the biggest faucets and biggest drains, and how deep is the money supply players are sitting on? This is the headline differentiator (US2, FR-012/013/014) — no surveyed self-hostable tool offers it first-class.

**Definition**. An **economy event** is a single currency-flow record classified as either a **source** (currency created and granted to the player — quest reward, daily bonus, loot, PvP win, passive generator) or a **sink** (currency permanently removed — shop purchase, upgrade, crafting, repair, cosmetic, time-skip, consumable). Per game × currency × UTC day we define, from the stream of valid economy events:

- **Total sources** = Σ `amount` over events where `flow_type = source`.
- **Total sinks** = Σ `amount` over events where `flow_type = sink`.
- **Net flow** = Total sources − Total sinks (persistently positive ⇒ inflation risk).
- **Sink ratio** = Total sinks / Total sources (healthy live economies steer ≈ 1.0; slightly faucet-positive ⇒ a sense of progression).
- **Per-reason breakdown** = the same source/sink totals partitioned by `reason`, yielding a ranked **top-faucet** list (sources by reason) and **top-drain** list (sinks by reason).
- **Currency depth / money supply** = the distribution of players' current balances for a currency (from `balance_after`), summarized as total held + percentiles.

Currencies are tracked **independently** — gold, gems, and energy inflate on separate curves; no cross-currency total is ever formed (no FX between virtual currencies in v1).

**Chosen variant & rejected alternatives**. We measure *flow* (per-event signed magnitudes summed into daily source/sink totals), not *balance deltas reconstructed from snapshots*. Rejected: (i) **balance-diff inference** (derive flow by diffing successive `balance_after` values) — requires per-user ordered balance history, impossible under results-only storage (§E) without raw re-scan, and blind to *why* currency moved (no `reason`). (ii) **Net-only tracking** (store only net flow, not gross source/sink) — cannot produce sink ratio or the faucet/drain breakdown, the whole point of the metric. Gross source and gross sink are the irreducible measures; everything else is derived from them.

## 2. SDK Data Captured

Economy is a **reserved, strictly-validated typed kind** (`kind = economy`, §H). It rides the canonical envelope (`game_id`, `user_id`/`anon_id`, `session_id`, `event_id`, `client_event_time`, `client_sent_time`, `server_received_time`, `props`); the fields below are the economy-specific payload, not a re-definition of the envelope.

**Required payload fields (a missing/invalid one → quarantine, see §6):**

| Field | Meaning | Required | Source of truth |
|---|---|---|---|
| `flow_type` | `source` or `sink`. Nothing else is valid. | Required | Emitter (client or server SDK) |
| `currency_type` | Currency identifier (e.g. `gold`, `gems`, `energy`). Free-form string, per-game namespace; each tracked independently. | Required | Emitter |
| `amount` | Positive magnitude of currency moved. Direction is carried by `flow_type`, never by sign — `amount` is always > 0. | Required | Emitter |
| `reason` / `category` | Why the flow happened (`quest_reward`, `daily_bonus`, `shop_purchase:sword`, `upgrade:barracks`, …). Drives the faucet/drain breakdown. | Required | Emitter |

**Optional payload fields:**

| Field | Meaning | Required | Source of truth |
|---|---|---|---|
| `balance_after` | Player's balance of `currency_type` immediately after this flow. Feeds currency depth / money supply. Omitting it does not invalidate the event; it only removes that event from depth computation. | Optional | Emitter (client-observed unless server-authoritative) |
| player context (`player_level`, `region`, `days_since_install`, `is_payer`, optional `in_game_state`) | Purchase-time / grant-time context for segmentation. Read from `props` or promoted dimensions. | Optional | Emitter |

**Trust boundary (client-sent vs server-sent)**. Economy events are **spoofable when client-sent** — a modified client can inflate faucets or hide sinks. Two trust tiers, both accepted into the same aggregates but distinguishable:

- **Client SDK** economy events: convenience path for currency flows the server never sees (purely client-simulated economies, cosmetic sinks). Accepted, but inherently untrusted.
- **Server SDK** economy events (FR-007): the **trusted path** for server-granted / server-debited currency, where economy integrity matters (real-money-adjacent grants, anti-cheat-sensitive faucets). The server SDK shares the same ingest contract and the same `economy` typed kind.

An emitter-`source` flag distinguishing `client` vs `server` provenance (mirroring the purchase `source` flag in §D) **should** be derivable per economy event so a dashboard can, at minimum, show trusted-only totals (adoption pending the shared envelope call in §F-3 — see §7). Which flows a game routes through the server SDK is the game's decision; the platform records provenance and does not itself re-validate currency math in v1.

## 3. Admin Configuration

| Knob | Default | Range / values | Retroactive or forward-only |
|---|---|---|---|
| `economy_top_n_reasons` | 10 | 1–100 | **Retroactive** — display-time ranking/truncation over the per-reason result; changing it re-renders from existing stored per-reason totals, no re-bucketing. |
| `economy_currency_allowlist` | empty = accept all | set of currency strings, or empty | **Forward-only** — if enabled to reject unknown currencies, past aggregates are untouched (a formerly-accepted currency's sealed days stay). Default (empty) accepts any currency and auto-registers it, matching §H accept-all posture for the free-form parts. |
| `economy_depth_capture_mode` | `last_known_balance` | `last_known_balance` \| `off` | **Forward-only** — depth is only computable for days processed while enabled (see §5). Turning it on does not backfill depth for sealed days. |
| `level_bucket_boundaries` (shared, FR-027) | platform default buckets | ordered level thresholds | **Forward-only** — re-bucketing sealed segmented aggregates would violate §G/§B immutability; applies to new days only. |
| `per_game_reporting_timezone_offset` (shared, FR-027) | UTC | offset | **Display-only** — never re-buckets stored aggregates (§G-3); economy days remain UTC internally. |

Shared platform knobs also in force: Postgres flush cadence (5 min, §E), dedup window (24h, §F), late-event grace / day-seal (48h, §G), per-game event-name cap (500, §H). Default rule (brief): anything affecting sealed aggregates is forward-only; the two retroactive knobs above are safe because they only re-read or re-rank already-stored results.

## 4. Calculation

**Time-bucketing**: per **UTC day** (§G), keyed on **skew-corrected client-event-time** (`corrected = client_event_time + (server_received_time − client_sent_time)`). A day is mutable 48h then seals; economy events for a sealed day are quarantined, never folded in (§G).

**Segment grain**: base grain is **game × currency_type × UTC day × reason** (source total and sink total at each). Headline figures (total source, total sink, net flow, sink ratio) are the reason-collapsed rollup of that grain. Optional secondary grain adds player-context dimensions (level bucket, region) where present — same measures, sliced.

**Formulas** (per game × currency × day, unless a segment is named):

```
total_source        = Σ amount           where flow_type = source
total_sink          = Σ amount           where flow_type = sink
net_flow            = total_source − total_sink
sink_ratio          = total_sink / total_source        (undefined / N/A if total_source = 0)
per_reason_source[r]= Σ amount           where flow_type = source AND reason = r
per_reason_sink[r]  = Σ amount           where flow_type = sink   AND reason = r
top_faucets         = per_reason_source sorted desc, take economy_top_n_reasons
top_drains          = per_reason_sink   sorted desc, take economy_top_n_reasons
```

Currency depth (per game × currency, point-in-time, not per-day-summed):

```
money_supply        = Σ over users of (last_known balance_after for this currency)
depth_pXX           = percentile XX of the per-user last-known balances
```

**Worked example** — one game, one UTC day (2026-07-17), two currencies, multiple reasons.

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

**Currency depth (worked, gold, same game):** suppose last-known gold balances across all users are u1=1300, u2=800, u3=2200 → money_supply(gold) = **4300**; median depth = **1300**. Rising money_supply day-over-day is the accumulation signal that corroborates the positive net-flow reading above.

**Immature / partial-window handling.** The **current UTC day** (and anything inside the 48h grace) is **provisional** — economy totals may still grow as late events fold in; the dashboard marks today's figures provisional (§E-2). `sink_ratio` with `total_source = 0` renders **N/A**, never 0 or ∞. Depth for a day is only available if `economy_depth_capture_mode` was enabled during that day (see §5).

## 5. Data-Shape Requirements (WHAT must be derivable — NOT how it's stored)

**Primary result shape.** Per **game × currency_type × UTC day × reason × flow_type**, we must be able to produce a **running summed amount**. From this single grain everything in §4 is derivable: collapse `reason` for headline source/sink totals → net flow and sink ratio; keep `reason` for the faucet/drain breakdown. Phrased as the constraint: *per game × currency × day × reason, we must maintain a source-amount total and a sink-amount total, incrementally accumulated as events arrive.*

**Segmented result shape (optional, where context present).** Per **game × currency × day × segment-key (level_bucket, region) × reason × flow_type**, the same source/sink totals — so economy can be sliced by player context. This multiplies grain cardinality by the segment fan-out; kept bounded by the level-bucket config and by only materializing segments actually observed. If a segment dimension is absent on an event, that event contributes only to the unsegmented grain.

**Currency-depth shape (per-user spine touch, minimal).** Money supply / depth needs a *current* balance per user per currency — a snapshot, not history. To satisfy this **without raw re-scan**, capture at definition level a **last-known balance per (game, user, currency)**: each valid economy event carrying `balance_after` overwrites that user's last-known balance for that currency (last-writer-by-corrected-event-time wins). Money supply = Σ of these last-known balances; depth percentiles = distribution over them. This is an *upsert-latest* per user×currency, **not** an append log — it is the minimal spine extension the depth metric requires, justified because there is no other results-only way to know current balances. Alternative considered and deferrable: a **periodic distribution snapshot** (histogram of balances captured at day-seal) instead of live last-known — cheaper on the spine but coarser; recommended default is `last_known_balance` (see §7). Either way, **no per-event balance history is stored.**

**Per-user-spine requirement.** Beyond the shared spine (`first_seen`, `active_days_bitmap`), economy adds at most the optional **last-known balance per user × currency** above, only when depth capture is on. The core source/sink/net/ratio/breakdown metrics need **zero** per-user state — they are pure per-day aggregate accumulation.

**Results-only confirmation.** All of §4 except depth is computable purely from incrementally-accumulated per-(game×currency×day×reason×flow) totals — no raw re-scan, satisfying the results-only constraint (FR-010). Net flow and sink ratio are arithmetic over two stored totals. Depth is computable from the minimal last-known-balance spine, also without raw re-scan. **No red flag.** (NO DDL, column types, or Redis keys specified here by design — those are `/plan` choices.)

## 6. Edge Cases & Failure Modes

- **Invalid economy event → quarantine (§H, strict typed kind).** An economy event is **valid** iff it has `kind = economy`, a `flow_type` ∈ {`source`,`sink`}, a non-empty `currency_type`, a numeric `amount > 0`, and a non-empty `reason`. Any missing/malformed required field → the event is **quarantined to the raw file** (the dead-letter floor), **not** counted toward any economy total and **not** silently dropped. Specifically quarantined: unknown/absent `flow_type`; negative, zero, non-numeric, or absent `amount`; absent `currency_type` or `reason`. A free-form event merely *named* `economy` also routes to this strict path (§H-2 reserved-name collision) and quarantines if it doesn't satisfy the shape. Nameless/unparseable events are dropped-with-counter, never reaching this path.
- **Dedup (§F).** Economy is a non-money typed kind → deduped by **`event_id` + 24h window**, measured on server-receive-time (§F-1). A retried batch within 24h is idempotently skipped; a retry landing >24h later double-counts the flow into that day's source/sink total — an **accepted indie-scale tradeoff** for non-money events (unlike purchases, which are durably deduped). Note: absolute-upsert flush (§E) protects the flush path but does *not* stop a re-counted event — `event_id` dedup is the only guard, hence economy totals inherit §F's residual risk.
- **Amount sign convention.** Direction is carried solely by `flow_type`; `amount` is always a positive magnitude. A negative `amount` is treated as malformed → quarantine (not "auto-flipped to the other flow_type"), keeping validation unambiguous.
- **Late / sealed-day events (§G).** An economy event whose corrected time lands in a **sealed** day (>48h old) is quarantined to the raw file, **never** folded into the sealed source/sink total — preserving day immutability. It is recoverable only via the manual raw-file rebuild (§X-1). This means a burst of offline-buffered currency flows returning after 48h will be absent from headline totals but present in quarantine.
- **Clock skew (§G).** Bucketing uses skew-corrected client time; under 60s skew the raw client clock is trusted; future-dated single events (no batch skew reference) clamp to server-now (§G-1) — so a fast-clocked client can't push a flow into tomorrow's economy bucket.
- **Redis loss (§E).** Economy hot counters are transient; a Redis loss forfeits at most the current-day, not-yet-flushed source/sink increments (≤5 min drift + today's live counters). Durable results (flushed ≤5 min ago) and the **complete** raw file (write-ahead append *before* counter update) survive — so no economy event is ever counted-but-unlogged (SC-008). Recovery of the lost slice is via manual rebuild from the raw file.
- **Missing `balance_after`.** Depth is best-effort: events without `balance_after` simply don't update last-known balance. If a user *never* emits `balance_after`, they're absent from money-supply/depth (an under-count of depth, not of source/sink totals). Depth figures should be labelled as covering only balance-reporting users.
- **Spoofed client economy.** A modified client can inflate faucets / suppress sinks. The platform does not detect this in v1; the mitigation is the **server-SDK trusted path** for flows that matter (§2) plus derivable client/server provenance so a dashboard can show trusted-only totals. Trust is a routing decision by the game, not a validation the platform performs.
- **Unknown currency proliferation.** With the default empty allowlist, a buggy client emitting random `currency_type` strings inflates grain cardinality. Bounded by the shared per-game event-name cap posture (§H-4) applied analogously to currencies; `economy_currency_allowlist` is the explicit lever if it becomes a problem.

## 7. Open Questions

- **Currency-depth capture mechanism [LEANING].** Live **last-known balance per user × currency** (upsert-latest) vs **day-seal distribution snapshot**. *Default: `last_known_balance` (§5) — simplest results-only path, gives live money supply + percentiles; snapshot is a deferrable cheaper-spine alternative if the per-user×currency balance map grows uncomfortable.* Decide at `/plan`.
- **`balance_after` trust / negative-balance handling [OPEN].** `balance_after` is client-observed unless server-authoritative and can be spoofed or arrive out of order; a stale event could overwrite a newer balance if event-time ordering is imperfect. *Recommendation: last-writer-by-corrected-event-time wins; clamp implausible negatives out of depth; treat depth as advisory, not trusted, unless server-sourced.*
- **Economy `source` provenance flag [LEANING].** Whether every economy event carries an explicit `client`/`server` provenance flag (as purchases do, §D). *Recommendation: yes — carry it so trusted-only economy views are derivable; mirrors the purchase `source` flag.* Depends on the same envelope decision as §F-3 (server-SDK event ids).
- **Session dependency (§X-2).** Economy events reference `session_id` from the envelope; economy itself imposes no new session semantics — it inherits the locked SDK-managed session definition. No open question of its own, but economy per-session analysis (currency-per-session) is unavailable under results-only (no per-user session history), consistent with the sessions sheet's note on `sessions_before_purchase`. *Default: no per-session economy rollup in v1.*
- **Segment cardinality bound [LEANING].** Segmented economy (currency × day × level_bucket × region × reason × flow) can fan out. *Recommendation: only materialize observed segments; bound by `level_bucket_boundaries` config and a small fixed region set; if cardinality bites, restrict segmentation to headline totals (drop per-reason within segment).* Confirm at `/plan`.
- **PII in `reason` / context (§H-3).** `reason` and promoted context are operator-authored strings and could carry PII. *Recommendation: inherit the platform-wide config denylist / hashing (§H-3); solo-operator-trusted in v1.*
- **Timezone-change on economy history (§G-3).** A per-game reporting-timezone change must stay **display-only** and never re-bucket sealed economy days. *Recommendation: UTC internal always; offset at display; a true timezone change is a rebuild-forward, like monetization dimensions.*
