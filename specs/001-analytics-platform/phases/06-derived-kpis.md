# Phase 06 — Derived KPIs

**Feature**: 001-analytics-platform · **Story**: overall health & profitability KPIs · **Reserved kind owned**: none (derived) · **Status**: Draft
**Depends on**: **Phase 02 (sessions → active-user counts)**, **Phase 05 (revenue rollup + payer set)**, **Phase 04 (user spine / `first_seen`)**.
**Deeper reference**: [`../metrics/07-derived-kpis.md`](../metrics/07-derived-kpis.md).
**Excluded here** (→ later per-phase design): distinct-count sketch choice, key layouts, DDL.

---

## 1. Story understanding

**The story.** The developer sees the composite KPIs every game dashboard reports: how many players are active (DAU/WAU/MAU), how habitual they are (stickiness), how much money each player type produces (ARPU/ARPPU/ARPDAU), what fraction pay (conversion), and how concentrated revenue is among the biggest spenders (whale concentration).

**The question it answers.** *How healthy and how profitable is the game overall?* These are **derived** — computed from results the other phases already maintain (session/active-user counts, the retention spine, the monetization revenue rollup) plus a small denominator spine. Almost none need their own SDK event.

**Definitions (chosen variants):**
- **DAU / WAU / MAU** = distinct active `user_id`s (≥ 1 session **started** in the period; the §B-1 activeness anchor). DAU = exact distinct-per-UTC-day; WAU/MAU = distinct over trailing **7 / 30** rolling UTC days — distinctness holds *across* days (a user active on 12 of 30 days counts once in MAU). Rejected: "active = any event" (over-counts pings; would disagree with retention) and calendar-month MAU (rolling-30 is the internal grain; calendar is a display variant).
- **Stickiness** = DAU / MAU (same report day). ~0.2 is a common sticky bar.
- **ARPU** = period revenue ÷ active users (payers + non-payers).
- **ARPPU** = period revenue ÷ paying users (distinct users with ≥ 1 verified prod purchase). ARPPU ≥ ARPU always.
- **ARPDAU** = daily revenue ÷ DAU (the day-grain ARPU; the most-watched monetization pulse).
- **Conversion** = distinct paying ÷ distinct active. **First-purchase conversion** = distinct users whose **first-ever** verified purchase fell in the period ÷ active (or new) users — a flow rate.
- **Whale concentration** = share of period revenue from the **top X% of payers** by spend (default X ∈ {1%, 5%, 10%}). The one KPI needing a *new maintained aggregate* (a per-payer spend distribution).
- **(Optional) New / Returning / DAU composition** = new users (`first_seen` in period) + returning (active, `first_seen` before period) = DAU, disjoint.

**What it means for the operator.** One glance at whether the game is growing, habitual, and profitable — and how dependent it is on a few whales.

---

## 2. How it is calculated

All bucketing is **UTC day**; WAU = trailing 7, MAU = trailing 30; headline grain is whole-game. All money is normalized, prod + verified only.

```
DAU(d)          = |{ user_id : a session STARTED on UTC day d }|
WAU(d)          = |{ user_id : a session STARTED in [d-6 .. d] }|      (distinct across 7)
MAU(d)          = |{ user_id : a session STARTED in [d-29 .. d] }|     (distinct across 30)
Stickiness(d)   = DAU(d) / MAU(d)
Revenue(P)      = Σ normalized amount over verified prod purchases in P
PayingUsers(P)  = |{ user_id : ≥1 verified prod purchase in P }|
ARPU(P)         = Revenue(P) / ActiveUsers(P)
ARPPU(P)        = Revenue(P) / PayingUsers(P)
ARPDAU(d)       = Revenue(d) / DAU(d)
Conversion(P)   = PayingUsers(P) / ActiveUsers(P)
FirstConv(P)    = |{ user_id : first-ever verified purchase in P }| / ActiveUsers(P)
WhaleShare(X,P) = (Σ spend of top ⌈X%·PayingUsers(P)⌉ payers) / Revenue(P)
NewUsers(P)     = |{ user_id : first_seen ∈ P }|
```

### Worked example — one UTC day `d` (given, already maintained by other phases)

DAU = 1,000; MAU = 5,000; revenue = $400; distinct payers = 40.
- **Stickiness** = 1,000/5,000 = **0.20** (~6 of 30 days).
- **ARPDAU** = $400/1,000 = **$0.40** (= ARPU(day) by definition).
- **ARPPU(day)** = $400/40 = **$10.00**.
- **Conversion(day)** = 40/1,000 = **4.0%**.

### Worked example — whale concentration (period P)

PayingUsers = 10, spend desc `[$500,$200,$120,$80,$40,$30,$15,$10,$3,$2]`, Revenue = $1,000.
- Top **10%** = 1 payer → $500 → **50.0%**. Top **20%** = $700 → **70.0%**. Top **50%** = $940 → **94.0%**. Classic whale shape — *only* computable if the per-payer spend distribution for P is retained.

### DAU composition

DAU = 1,000; 150 have `first_seen == d` → **New 150, Returning 850** (disjoint, sum = DAU).

**Immature/partial:** WAU with < 7 days, MAU/stickiness with < 30, render **N/A** (masked) — never a low number. Today's ARPDAU/conversion are provisional; sealed prior days exact.

---

## 3. Data needed (input)

**Essentially NO new SDK event** — this phase consumes fields already required by Phases 02, 04, 05:

| Field | Used for |
|---|---|
| `user_id` | distinct-count key for DAU/WAU/MAU, active/paying denominators |
| `session` event + `session_start_time` | active-user membership (all denominators) — activeness is a client-SDK session concept |
| purchase revenue row (`transaction_id`, normalized amount, `verified`, `environment`, `source`) | numerators of ARPU/ARPPU/ARPDAU; payer set; per-payer spend for whale |
| first-purchase detection (server-side, per `user_id`) | first-purchase conversion, new-payer flow |
| `first_seen` (user spine) | new vs returning composition |

**Trust boundary (critical):** every **money numerator** is **server-sourced only** (verified prod purchases; sandbox excluded). Every **active-user denominator** comes from the **client-SDK session** stream. The **payer set** is server-derived (a payer has ≥ 1 verified prod purchase). No KPI trusts a client-reported revenue or a client "is_payer" flag.

---

## 4. Data stored for longer-run processing

Reuse first; add only the minimum:

- **(reuse) Active-user counts** — per game × UTC-day the distinct active-user set (session-start), *the same activeness the retention spine establishes*. DAU is exact-per-day; WAU/MAU are a set-union over 7/30 days. No new raw scan.
- **(reuse) Revenue numerators** — per game × UTC-day total normalized verified-prod revenue (the monetization rollup, summed over products). Period revenue = sum of daily totals.
- **(reuse) Paying-user counts** — per game × UTC-day the distinct set of `user_id`s with ≥ 1 verified prod purchase (sourced from the `transaction_id`→user idempotency spine); period payers = a window-union like MAU.
- **(new, minimal) First-purchase-day flag** — a write-once, idempotent per-payer field (mirrors the retention set-once bit) marking the day of a payer's first-ever verified purchase → first-purchase conversion.
- **(new, the one genuine spine expansion) Per-payer cumulative period spend** — per game × period × paying `user_id`, cumulative normalized verified-prod spend → whale ranking. Daily totals are insufficient (the distribution is lost once summed). **Payer-bounded** (payers ≪ users, a few % → thousands of rows/period at indie scale, not millions), so it stays results-only *in kind* and modest, but it does expand the spine beyond "a handful of columns per user." See the spine-budget ledger in `../metrics/README.md`.

**Distinct-over-window exactness:** DAU trivially exact; WAU/MAU/period-payers are set-unions of daily distinct sets — **exact in v1** (affordable at indie scale), with **HyperLogLog as the named scale lever** (approximate only ever touches distinct-*user counts*, never the money numerators). Computable without raw re-scan? **Yes.**

---

## 5. Data-structure thinking — Redis & database

*Conceptual shapes only.*

**Redis (transient, hot).**
- **Today's DAU set** — the distinct active-`user_id` set for today (reused from Phase 02); ARPDAU/conversion/stickiness read from it live.
- **Today's distinct-payer set** — `user_id`s with a verified prod purchase today.
- **Today's revenue counter** — running normalized verified-prod revenue.
- (Whale concentration is a **period aggregate, read from durable results** — not a hot counter, so unaffected by Redis loss.)

**Database (durable, results-only).**
- **Daily active-user sets** (or per-day sketches) — retained so any trailing window (WAU/MAU) is a union.
- **Daily payer sets** — same, for period-payer windows.
- **Daily revenue totals** — from the monetization rollup.
- **Per-payer first-purchase-day flag** — write-once on the payer spine.
- **Per-payer per-period cumulative spend** — the whale distribution; ranked and top-X%-summed at read time.

**The bridge.** Today's hot sets/counters flush to durable per-day results on the cadence; windowed KPIs union the retained daily sets. Because DAU/payer membership is set-based, duplicate-delivered sessions/purchases (24 h `event_id` window; durable `transaction_id`) collapse the same `user_id` and never inflate a distinct count.

---

## 6. Configurations

| Knob | Default | Range / values | Forward / retro |
|---|---|---|---|
| `mau_window_days` | 30 | 28–31 (WAU 7, DAU 1 fixed) | **Forward-only** for sealed daily active-sets (re-slices retained per-day data only if retained; else forward-only). |
| `whale_top_percents` | `[1, 5, 10]` | subset of 1–50 | **Retroactive IF** full per-payer period spend is retained (a re-rank, no re-scan); **forward-only** if only a top-k prefix is kept. The §4/§5 scope tradeoff (WC-1). |
| `active_definition` | `session_start` | `session_start` (v1-locked; `any_event` is v2-only) | **Locked to `session_start`** — inherits §B-1; not operator-settable in v1. |
| `arppu_first_purchase_denominator` | `active_users` | `active_users` / `new_users` | Forward-only (display choice for the first-purchase base). |
| `revenue_currency` | inherits monetization FX (§D-2) | config FX table | Forward-only (FX stamped at purchase date; no retro re-conversion). |
| `partial_window_mask` | on | on / off | **Display-only** — masks WAU/MAU/stickiness until the trailing window has fully elapsed. |
| `whale_min_payers` | 20 | integer | Below this, whale share is a single noisy user — still computed, flagged low-confidence. |

**Rule:** anything that would rewrite a sealed daily active-set or sealed revenue is forward-only. The deliberate exception is `whale_top_percents` (retroactive only because re-ranking a stored distribution needs no raw re-scan — and only if the full distribution is retained).

---

## Cross-references

- Deeper sheet: [`../metrics/07-derived-kpis.md`](../metrics/07-derived-kpis.md) — whale-concentration spine scope (WC-1), small-N masking, MAU window semantics, distinct-over-window exactness, gross-vs-net (inherits §D-1), all open questions.
- **Pure consumer:** reuses Phase 02 (activeness), Phase 04 (spine / `first_seen`), Phase 05 (revenue rollup + payer set). Its only new durable state is the payer-bounded first-purchase flag and per-payer period spend — reconciled against SC-007 in the ledger in `../metrics/README.md`.
