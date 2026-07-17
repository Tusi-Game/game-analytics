# Phase 03 — Economy (Sink / Source)

**Feature**: 001-analytics-platform · **Story**: US2 (P2 — the headline differentiator) · **Reserved kind owned**: `economy` · **Status**: Draft
**Depends on**: Phase 01 (ingest substrate). References Phase 02 for `session_id` provenance and the server-SDK trust path (shared with Phase 05).
**Deeper reference**: [`../metrics/02-economy-sink-source.md`](../metrics/02-economy-sink-source.md). **Spec**: US2, FR-012/013/014.
**Excluded here** (→ later per-phase design): key layouts, DDL, worker layout.

---

## 1. Story understanding

**The story.** The developer sends currency-flow events — currency granted = **source/faucet**, currency spent = **sink/drain** — and sees, per game per currency over time, total sources vs sinks, net flow, sink ratio, the biggest faucets and biggest drains by reason, and how deep players' balances are.

**The question it answers.** *Is this game's economy healthy, or is it inflating?* For each virtual currency: how much is being created vs destroyed, which mechanics are the biggest faucets/drains, and how much currency players are sitting on. This is the feature no surveyed self-hostable tool offers first-class — the primary reason to build.

**What it means for the operator.** A standalone economy dashboard: net flow persistently positive ⇒ inflation risk; sink ratio ≈ 1.0 ⇒ healthy balanced create/destroy; the top-faucet/top-drain lists say *which mechanic* to tune. Currencies are tracked **independently** — gold, gems, energy each inflate on their own curve; **no cross-currency total** (no FX between virtual currencies in v1).

**Chosen measure: flow, not balance-diff.** We sum per-event signed magnitudes into daily source/sink totals. Rejected: balance-diff inference (needs per-user ordered balance history — impossible under results-only, and blind to *why*) and net-only tracking (can't produce sink ratio or the breakdown). Gross source and gross sink are the irreducible measures; everything else derives from them.

**Trust boundary.** Economy events are spoofable when client-sent. Two tiers, both accepted but distinguishable: **client SDK** (convenience path for client-only flows, untrusted) and **server SDK** (the trusted path for server-granted/debited currency where integrity matters). A `client`/`server` provenance flag should be derivable so a dashboard can show trusted-only totals. The platform records provenance; it does not re-validate currency math in v1.

---

## 2. How it is calculated

**Time-bucketing.** UTC day (§G), skew-corrected client time; 48 h then seals; late events quarantined.

**Grain.** Base = **game × currency × UTC-day × reason × flow_type** (a source-total and a sink-total at each). Headline figures are the reason-collapsed rollup. Optional secondary grain adds player-context dimensions (level bucket, region) where present.

**Formulas (per game × currency × day unless a segment is named):**
```
total_source        = Σ amount where flow_type = source
total_sink          = Σ amount where flow_type = sink
net_flow            = total_source − total_sink
sink_ratio          = total_sink / total_source          (N/A if total_source = 0)
per_reason_source[r]= Σ amount where flow_type = source AND reason = r
per_reason_sink[r]  = Σ amount where flow_type = sink   AND reason = r
top_faucets         = per_reason_source sorted desc, take economy_top_n_reasons
top_drains          = per_reason_sink   sorted desc, take economy_top_n_reasons
money_supply(cur)   = Σ over users of (last-known balance_after for cur)   (point-in-time)
depth_pXX(cur)      = percentile XX of per-user last-known balances
```

### Worked example — one game, one UTC day, two currencies

Valid events that day (abbreviated):

| flow | currency | amount | reason |
|---|---|---|---|
| source | gold | 500 | quest_reward |
| source | gold | 300 | quest_reward |
| source | gold | 200 | daily_bonus |
| source | gold | 1000 | pvp_win |
| sink | gold | 400 | shop_purchase:sword |
| sink | gold | 250 | upgrade:barracks |
| sink | gold | 150 | repair |
| source | gems | 50 | daily_bonus |
| sink | gems | 80 | shop_purchase:skin |
| sink | gems | 20 | time_skip |

**Gold:** source = 2000, sink = 800, **net = +1200**, **sink ratio = 0.40**; top faucet = **pvp_win (1000)**; top drain = **shop_purchase:sword (400)**.
**Gems:** source = 50, sink = 100, **net = −50**, **sink ratio = 2.00**; top faucet = daily_bonus (50); top drain = shop_purchase:skin (80).

**Health read.** Gold is strongly faucet-positive (only 40% of created gold is drained → inflating; pvp_win out-emits every sink → throttle it or add a gold sink). Gems the opposite (spent faster than earned → draining reserves). Sink ratio ≈ 1.0 is the healthy target; this game is out of balance in opposite directions on the two currencies — exactly what US2's dashboard exists to surface.

**Currency depth (gold):** last-known balances u1=1300, u2=800, u3=2200 → money_supply = **4300**, median depth = **1300**. Rising money supply day-over-day corroborates the positive net-flow reading.

`sink_ratio` with source = 0 renders **N/A**. Today (and the 48 h grace) is provisional.

---

## 3. Data needed (input)

Economy is a **strictly-validated typed kind** (`kind = economy`). Rides the envelope; the economy payload:

**Required** (a missing/invalid one → quarantine to raw, never silently dropped):

| Field | Meaning |
|---|---|
| `flow_type` | `source` or `sink` — nothing else valid. |
| `currency_type` | Currency id (`gold`, `gems`, …), per-game namespace, tracked independently. |
| `amount` | Positive magnitude; direction is carried by `flow_type`, **never** by sign — `amount` is always > 0. |
| `reason` / `category` | Why the flow happened; drives the faucet/drain breakdown. |

**Optional:**

| Field | Meaning |
|---|---|
| `balance_after` | Player's balance of `currency_type` after this flow; feeds depth/money-supply. Omitting it only removes that event from depth. |
| player context (`player_level`→`level_bucket`, `region`, …) | For segmented economy where present. |

Provenance: a `client`/`server` `source` flag should ride each economy event (mirrors the purchase flag) so trusted-only totals are derivable.

---

## 4. Data stored for longer-run processing

- **Primary result — per game × currency × UTC-day × reason × flow_type:** a running summed `amount`. Collapse `reason` for headline source/sink → net flow, sink ratio; keep `reason` for the faucet/drain breakdown. Everything in §2 (except depth) derives from this one grain.
- **Segmented result (optional, where context present) — same, plus segment keys** (level_bucket, region). Multiplies cardinality by the segment fan-out; kept bounded by the level-bucket config and by only materializing observed segments.
- **Currency depth (optional per-user-spine touch) — last-known balance per (game, user, currency):** an *upsert-latest* snapshot (last-writer-by-corrected-event-time wins), **not** an append log. Money supply = Σ of these; depth = distribution over them. Only when `economy_depth_capture_mode` is on.

**Per-user spine.** The core source/sink/net/ratio/breakdown metrics need **zero** per-user state — pure per-day aggregate accumulation. Depth adds *at most* the optional last-known-balance-per-user×currency, only when enabled. No per-event balance history is ever stored. All of §2 is computable without raw re-scan. ✓

---

## 5. Data-structure thinking — Redis & database

*Conceptual shapes only.*

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

## 6. Configurations

| Knob | Default | Range / values | Forward / retro |
|---|---|---|---|
| `economy_top_n_reasons` | 10 | 1–100 | **Retroactive** — display-time ranking/truncation over stored per-reason totals; no re-bucketing. |
| `economy_currency_allowlist` | empty = accept all | set of currency strings | **Forward-only** — enabling rejection leaves past aggregates untouched; default accepts + auto-registers any currency (accept-all posture). |
| `economy_depth_capture_mode` | `last_known_balance` | `last_known_balance` / `off` | **Forward-only** — depth is only computable for days processed while enabled; turning it on does not backfill sealed days. |
| `level_bucket_boundaries` (shared) | platform default | ascending level thresholds | **Forward-only** — re-bucketing sealed segmented aggregates violates immutability. |
| `per_game_reporting_timezone_offset` (shared) | UTC | offset | **Display-only** — never re-buckets; economy days stay UTC internally. |

**Inherited globals:** flush 5 min, dedup 24 h, day-seal 48 h, event-name cap 500. Rule: anything touching sealed aggregates is forward-only; the two retroactive knobs above only re-read/re-rank already-stored results.

---

## Cross-references

- Deeper sheet: [`../metrics/02-economy-sink-source.md`](../metrics/02-economy-sink-source.md) — quarantine rules, spoofed-client mitigation, unknown-currency proliferation, depth-capture and provenance-flag open questions.
- Shares the **server-SDK trusted path** with Phase 05 (monetization). Consumes `session_id` from the envelope but imposes no session semantics; no per-session economy rollup in v1 (results-only).
