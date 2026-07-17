# Derived KPIs (DAU/ARPU/whale) — Spec

**Part of:** [001-analytics-platform](../001-analytics-platform/spec.md)
**Story:** overall health & profitability KPIs · **Reserved kind owned:** none (derived) · **Status:** Draft
**Depends on:** [003-sessions](../003-sessions/spec.md) (sessions → active-user counts), [006-monetization](../006-monetization/spec.md) (revenue rollup + payer set), [005-retention](../005-retention/spec.md) (user spine / `first_seen`).
**Shared substrate:** [foundation](../001-analytics-platform/foundation.md), [research](../001-analytics-platform/research.md), [bridge 05.5 — purchase-accept contract](../001-analytics-platform/bridges/05.5-purchase-accept-contract.md).

> **Note on this document.** This story is a **pure consumer**: it owns no event kind and stores no KPI value. The `## Design` section lives separately in [design.md](./design.md). Deeper calculation, worked examples, the full edge-case catalog, and the open-question ledger below are folded in from the derived-KPIs metric sheet — nothing is dropped.

---

## 1. Story understanding

**The story.** The developer sees the composite KPIs every game dashboard reports: how many players are active (DAU/WAU/MAU), how habitual they are (stickiness), how much money each player type produces (ARPU/ARPPU/ARPDAU), what fraction pay (conversion), and how concentrated revenue is among the biggest spenders (whale concentration).

**The question it answers.** *How healthy and how profitable is the game overall?* These are **derived** — computed from results the other stories already maintain (session/active-user counts, the retention spine, the monetization revenue rollup) plus a small denominator spine. Almost none need their own SDK event.

**Definitions (chosen variants):**

- **DAU / WAU / MAU** = distinct active `user_id`s (≥ 1 session **started** in the period; the [foundation](../001-analytics-platform/foundation.md) §B-1 activeness anchor — a `session` event whose **START day (UTC)** falls in the period is the activeness anchor). DAU = exact distinct-per-UTC-day; WAU/MAU = distinct over trailing **7 / 30** rolling UTC days — distinctness holds *across* days (a user active on 12 of 30 days counts once in MAU).
  - *Rejected:* "active = any event" (over-counts background/telemetry pings; inconsistent with retention, which is session-anchored — [005-retention](../005-retention/spec.md) §B-1 default is "≥ 1 `session` event"). We align DAU with retention activeness so the two dashboards never disagree.
  - *Rejected:* calendar-month MAU (Jan-1…Jan-31). We use **rolling 30-day** MAU (trailing window) as the default because stickiness (DAU/MAU) is only meaningful on a rolling window; calendar MAU is offered as a display variant, not the internal grain.
- **Stickiness** = DAU / MAU (both on the same report day; MAU = trailing 30d). Range (0,1]; higher = users return more days per month. A common "sticky" bar is ≈ 0.2 (active ~6 of 30 days).
- **ARPU** = period revenue ÷ active users (payers + non-payers).
- **ARPPU** = period revenue ÷ paying users (distinct users with ≥ 1 verified prod purchase). ARPPU ≥ ARPU always.
- **ARPDAU** = daily revenue ÷ DAU (the day-grain ARPU; the most-watched monetization pulse).
- **Conversion (payer conversion)** = distinct paying ÷ distinct active. **First-purchase conversion** = distinct users whose **first-ever** verified purchase fell in the period ÷ active (or new) users — a flow rate, not a stock ratio.
- **Whale concentration** = share of period revenue from the **top X% of payers** by spend (default X ∈ {1%, 5%, 10%}). The one KPI needing a *new maintained aggregate* (a per-payer spend distribution).
- **(Optional) New / Returning / DAU composition** = new users (`first_seen` in period) + returning (active, `first_seen` before period) = DAU, disjoint by construction.

**What it means for the operator.** One glance at whether the game is growing, habitual, and profitable — and how dependent it is on a few whales.

---

## 2. How it is calculated

All bucketing is the platform **logical day** ([foundation](../001-analytics-platform/foundation.md) §4.7 — `utc_day(corrected + reporting_offset)`, single platform timezone; every "UTC day" below reads as the logical day); WAU = trailing 7, MAU = trailing 30; headline grain is whole-game (per `game_id`). Segmentation by monetization dimensions is a [006-monetization](../006-monetization/spec.md) concern and out of scope here. All money is normalized, prod + verified only ([foundation](../001-analytics-platform/foundation.md) §D-2).

```
DAU(d)          = |{ user_id : a session STARTED on UTC day d }|
WAU(d)          = |{ user_id : a session STARTED in [d-6 .. d] }|      (distinct across 7 days)
MAU(d)          = |{ user_id : a session STARTED in [d-29 .. d] }|     (distinct across 30 days)
Stickiness(d)   = DAU(d) / MAU(d)
Revenue(P)      = Σ normalized amount over verified prod purchases in P
PayingUsers(P)  = |{ user_id : ≥1 verified prod purchase in P }|       (distinct)
ARPU(P)         = Revenue(P) / ActiveUsers(P)
ARPPU(P)        = Revenue(P) / PayingUsers(P)
ARPDAU(d)       = Revenue(d) / DAU(d)
Conversion(P)   = PayingUsers(P) / ActiveUsers(P)
FirstConv(P)    = |{ user_id : first-ever verified purchase in P }| / ActiveUsers(P)
WhaleShare(X,P) = (Σ spend of top ⌈X%·PayingUsers(P)⌉ payers) / Revenue(P)
NewUsers(P)     = |{ user_id : first_seen ∈ P }|
Returning(P)    = ActiveUsers(P) − NewUsers-active-in-P
```

### Worked example — one UTC day `d` (game G, already maintained by other stories)

Given (all already maintained by other engines):
- Distinct active users (sessions started on `d`): **DAU = 1,000**
- Distinct active users over trailing 30d: **MAU = 5,000**
- Verified prod revenue on `d`: **$400.00**
- Distinct paying users on `d`: **40**

Then:
- **Stickiness** = 1,000 / 5,000 = **0.20** (users active ~6 of 30 days — a healthy sticky game).
- **ARPDAU** = $400 / 1,000 = **$0.40**.
- **ARPU(day)** = $400 / 1,000 = **$0.40** (day-grain ARPU == ARPDAU by definition).
- **ARPPU(day)** = $400 / 40 = **$10.00** (each payer averaged $10).
- **Conversion(day)** = 40 / 1,000 = **4.0%**.

### Worked example — whale concentration (period P, game G)

PayingUsers(P) = **10**, sorted spend descending:
`[$500, $200, $120, $80, $40, $30, $15, $10, $3, $2]`, Revenue(P) = **$1,000**.
- Top **10%** = ⌈0.10·10⌉ = 1 payer → $500 → **50.0%** of revenue.
- Top **20%** = 2 payers → $500 + $200 = $700 → **70.0%**.
- Top **50%** = 5 payers → $500 + $200 + $120 + $80 + $40 = $940 → **94.0%**.

This is the classic whale-heavy shape (one whale = half the revenue) and is *only* computable if the **per-payer spend distribution for P is retained** (see §5 and Open Questions).

### Worked example — DAU composition

DAU = 1,000; of those, 150 have `first_seen == d` → **New = 150, Returning = 850** (disjoint; sum = DAU).

**Immature / partial-window handling:** WAU on a game with < 7 days of data, and MAU/stickiness with < 30 days, render **N/A / masked** (per `partial_window_mask`), never a low number — same discipline as [005-retention](../005-retention/spec.md) §B-2 immature-cohort masking. ARPDAU/conversion for **today** are provisional (Redis-live, last ~5 min may lag; [foundation](../001-analytics-platform/foundation.md) §E-2) and carry the "provisional" note; sealed prior days are exact.

---

## 3. Data needed (input)

**Essentially NO new SDK event** — this story consumes fields already required by sessions ([003-sessions](../003-sessions/spec.md)), retention ([005-retention](../005-retention/spec.md)), and monetization ([006-monetization](../006-monetization/spec.md)). Enumerated as *uses of* the canonical envelope, not additions:

| Field | Meaning | Req/Opt | Source of truth | Used for |
|---|---|---|---|---|
| `user_id` | stable player id (envelope) | required | client (game-provided) | distinct-count key for DAU/WAU/MAU, active/paying denominators |
| `session` event + `session_start_time` | start day (UTC) sets activeness (sessions + §B-1) | required | **client SDK** (session is SDK-managed) | active-user membership (all denominators — DAU/WAU/MAU, ARPU/ARPDAU/conversion) |
| purchase revenue row (`transaction_id`, normalized amount, `verified`, `environment`, `source`) | server-verified money ([foundation](../001-analytics-platform/foundation.md) §D) | required | **server SDK** (revenue is server-only) | numerators of ARPU/ARPPU/ARPDAU; payer set; per-payer spend for whale |
| `is_first_purchase` / first-purchase detection | flags a payer's first-ever verified purchase | derived | **server-side** (first verified txn per `user_id`) | first-purchase conversion, new-payer flow |
| `first_seen` (user spine) | install-day anchor | required | server-derived on first session | new vs returning composition |

**Trust boundary (critical):** every **money numerator** (ARPU/ARPPU/ARPDAU revenue, per-payer spend) is **server-sourced only** ([foundation](../001-analytics-platform/foundation.md) §D — "client is the messenger, not the money source of truth"; sandbox `environment` excluded, only `verified` prod purchases). Every **active-user denominator** comes from the **client-SDK session** stream (activeness is a client concept). The **payer set** is server-derived (a user is a payer iff they have ≥ 1 verified prod purchase). No KPI trusts a client-reported revenue or a client "is_payer" flag for the money side.

---

## 4. Data stored for longer-run processing

Reuse first; add only the minimum:

- **(reuse) Active-user counts** — per game × UTC-day the distinct active-user set (session-start), *the same activeness the retention spine establishes*. DAU is exact-per-day; WAU/MAU are a set-union over 7/30 days de-duplicated. DAU/WAU/MAU are a reprojection of retention activeness by day rather than by cohort-offset. No new raw scan.
- **(reuse) Revenue numerators** — per game × UTC-day total normalized verified-prod revenue (the monetization rollup, summed over products). Period revenue = sum of daily totals. No new aggregate.
- **(reuse) Paying-user counts** — per game × UTC-day the distinct set of `user_id`s with ≥ 1 verified prod purchase (sourced from the `transaction_id`→user idempotency spine, already durable and allowed alongside results-only); period payers = a window-union like MAU.
- **(new, minimal) First-purchase-day flag** — a write-once, idempotent per-payer field (mirrors the retention set-once bit) marking the day of a payer's first-ever verified purchase → first-purchase conversion. Justified because first-purchase conversion is a headline KPI that cannot be re-derived from results-only otherwise.
- **(new, the one genuine spine expansion) Per-payer cumulative period spend** — per game × period × paying `user_id`, cumulative normalized verified-prod spend → whale ranking. Daily totals are insufficient (the distribution is lost once summed). **Payer-bounded** (payers ≪ users, a few % → thousands of rows/period at indie scale, not millions), so it stays results-only *in kind* and modest, but it does expand the spine beyond "a handful of columns per user." See the spine-budget ledger in the [monetization metrics README](../006-monetization/spec.md), which reconciles funnel progress, economy last-known balance, and the two payer-spine fields here against SC-007.

**Distinct-over-window exactness:** DAU trivially exact (one day); WAU/MAU/period-payers are set-unions of daily distinct sets — **exact in v1** (affordable at indie scale, union the retained daily distinct-user sets), with **HyperLogLog (HLL) as the named scale lever** (per-day HLL sketches merge to give approximate WAU/MAU/period-payers cheaply if daily distinct-set retention becomes too large; approximate only ever touches distinct-*user counts*, never the money numerators). Computable without raw re-scan? **Yes.**

**Net verdict:** DAU/WAU/MAU, stickiness, ARPU/ARPPU/ARPDAU, conversion are **v1-trivial** — they fall straight out of existing session-active results + monetization revenue rollup + a distinct-payer count. **Whale concentration** requires a **new per-payer-cumulative-spend aggregate** (the only genuine spine expansion). **First-purchase conversion** needs a minimal once-set first-purchase-day flag on the payer spine.

---

## 5. Data-structure thinking — Redis & database

*Conceptual shapes only. The governing claim: every KPI here is computable from results the other engines already maintain plus a minimal denominator spine — WITHOUT a raw event re-scan.*

**Redis (transient, hot).**
- **Today's DAU set** — the distinct active-`user_id` set for today (reused from [003-sessions](../003-sessions/spec.md)); ARPDAU/conversion/stickiness read from it live.
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

### Data-shape requirements (WHAT must be derivable — NOT how it's stored)

**(a) Active-user counts (DAU/WAU/MAU) — reuse the session/active-user result.** Per `game_id` per UTC day, produce **the set (or exact distinct count) of active `user_id`s** whose session started that day. DAU is exact-per-day; WAU/MAU require distinctness **across a window** (union of daily active-sets over 7/30 days, de-duplicated). Derivable shape: *per game × UTC-day, the distinct active-user set for that day* (any trailing window is a set-union). This is the **same activeness data the retention spine establishes** (session-start bit). **No new raw scan.**

**(b) Revenue numerators — reuse the monetization revenue rollup.** Per `game_id` per UTC day, produce **total normalized verified-prod revenue** (already maintained by monetization as the day/product rollup — sum over products gives the daily total). Period revenue = sum of daily totals. **No new aggregate.**

**(c) Paying-user counts — a distinct-payer count per period.** Per `game_id` per UTC day, produce **the distinct set (or count) of `user_id`s with ≥ 1 verified prod purchase that day**, so period PayingUsers is a window-union like MAU. The purchase idempotency spine (`transaction_id`→user, already durable per [foundation](../001-analytics-platform/foundation.md) §D/§F, allowed alongside results-only) can source distinct payers without a raw scan. **First-purchase** needs a per-user "first verified purchase day" — a **once-set flag on the payer's first appearance** (analogous to the retention set-once bit; write-once, idempotent). A **minimal** payer-spine addition.

**(d) Whale concentration — the one KPI *within this story* that needs a NEW maintained aggregate.** (Across the whole platform it is one of several per-user/per-payer spine draws — see the spine-budget ledger in the [monetization metrics README](../006-monetization/spec.md), which reconciles funnel progress, economy last-known balance, and the two payer-spine fields here against SC-007.) Whale share needs a **per-payer cumulative spend for the period** (to rank and take the top X%). Daily revenue totals are insufficient — the distribution is lost once summed. Minimal derivable shape: **per `game_id` per period (e.g. per rolling/calendar month), per paying `user_id`, cumulative normalized verified-prod spend.** This is a **per-payer aggregate**, wider than the pure result grain. Honest tradeoff vs **SC-007** (Postgres holds only results + minimal spine): it stays results-only in *kind* (an aggregate, not raw events) and is bounded by **payer count, not user count** — thousands of rows/period at indie scale, not millions. It **does modestly expand the spine**. Two containment options for /plan (Open Question WC-1): (i) retain the full per-payer period spend distribution (enables retroactive `whale_top_percents` re-ranking, richer percentiles); or (ii) retain only a **top-k prefix** (e.g. top 100 spenders/period) — much smaller, but fixes the reportable percentiles forward-only and can't answer an arbitrary later X%.

**Distinct-count over a window (a + c) — exact-vs-approximate tension** (consistent with sessions §S-3). DAU is trivially exact (one day). WAU/MAU/period-payers require **distinct-over-a-window** counts whose exact form is a set-union of daily active/payer sets. Per the sessions sheet's §S-3 posture: **v1 keeps these EXACT** (union the retained daily distinct-user sets — feasible at indie scale). **HLL is the named scale lever**, not a v1 default (per-day HLL sketches merge to give approximate WAU/MAU/period-payers if daily distinct-set retention becomes too large). Never approximate the **money** numerators — those are exact sums; approximation only ever touches distinct-user *counts*.

---

## 6. Edge cases & failure modes

- **Distinct-count over a window (WAU/MAU/payers) double-count:** a user active on multiple days must count **once**. Guaranteed by the set-union / distinct semantics; consistent with retention's set-once bitmap idempotence. Duplicate-delivered sessions ([foundation](../001-analytics-platform/foundation.md) §F `event_id` 24 h window) don't inflate distinct sets — the same `user_id` collapses regardless.
- **Sealed / late events ([foundation](../001-analytics-platform/foundation.md) §G):** DAU/ARPDAU/whale for a **sealed** UTC day are frozen; a session or purchase arriving > 48 h late for a sealed day is **quarantined to the raw file**, never folded in — so a headline KPI for a sealed day never silently shifts (preserves §B/§G immutability). Today's KPIs remain mutable within the 48 h grace.
- **Clock skew ([foundation](../001-analytics-platform/foundation.md) §G):** activeness day = skew-corrected client session-start UTC day; a future-dated session clamps to server-now before its day is assigned, so it can't wrongly inflate a future DAU. Money uses server-received purchase time (server-trusted), immune to client skew.
- **Redis loss ([foundation](../001-analytics-platform/foundation.md) §E):** today's live DAU/ARPDAU/conversion counters are transient (accept-loss); sealed prior-day KPIs are Postgres-durable (flushed ≤ 5 min). A `today` KPI shown from Redis-live carries the "provisional" note (§E-2). Whale concentration is a period aggregate, not a hot counter — read from durable results, unaffected by Redis loss.
- **Missing client context companion ([foundation](../001-analytics-platform/foundation.md) §D-5):** does **not** affect these KPIs — they need only the **server revenue row** (amount + user) for numerators and the **session** for denominators, never the client context dimensions. A purchase with no companion still counts fully in ARPU/ARPPU/ARPDAU/whale.
- **Sandbox / unverified purchases ([foundation](../001-analytics-platform/foundation.md) §D):** excluded from every revenue numerator and from the payer set (`environment=sandbox` or `verified=false` never counts) — so ARPPU/conversion/whale reflect real money only.
- **Division-by-zero / small-N:** DAU = 0 ⇒ ARPDAU/stickiness **N/A** (not 0); PayingUsers = 0 ⇒ ARPPU **N/A**; a whale percentile ⌈X%·payers⌉ that rounds to 0 with 0 payers ⇒ **N/A**. Very-small payer counts make whale share noisy — mask or annotate below a min-payer threshold (Open Question WC-2).
- **`user_id` reuse / anon→identified:** distinct counts key on the final game-provided `user_id`; `session_id` is stable across an anon→user transition within a session (SESSIONS decision), so a login mid-session does not create a phantom second active user. Anon↔user merge remains out of scope (v1) — a pre-login anon that never logs in counts as its own active user.

---

## 7. Configurations

| Knob | Default | Range / values | Forward / retro |
|---|---|---|---|
| `mau_window_days` | 30 | 28–31 (WAU 7, DAU 1 fixed) | **Forward-only** for sealed daily active-sets (re-slices retained per-day data only if retained; else forward-only). |
| `whale_top_percents` | `[1, 5, 10]` | subset of 1–50 (integers) | **Retroactive IF** full per-payer period spend is retained (a re-rank, no re-scan); **forward-only** if only a top-k prefix is kept. The §5 scope tradeoff (WC-1). |
| `active_definition` | `session_start` | `session_start` (v1-locked; `any_event` is v2-only) | **Locked to `session_start`** — inherits §B-1 ([005-retention](../005-retention/spec.md) §7 forbids generic events marking activeness); `any_event` deferred to v2 alongside the optional per-game "qualifying action"; not operator-settable in v1. |
| `arppu_first_purchase_denominator` | `active_users` | `active_users` / `new_users` | Forward-only (display choice for the first-purchase base). |
| `revenue_currency` | inherits monetization FX ([foundation](../001-analytics-platform/foundation.md) §D-2) | config FX table | Forward-only (FX stamped at purchase date; no retro re-conversion). |
| `partial_window_mask` | on | on / off | **Display-only** — masks WAU/MAU/stickiness until the trailing window has fully elapsed. |
| `whale_min_payers` | 20 | integer | Below this, whale share is a single noisy user — still computed, flagged low-confidence. |

**Rule:** anything that would rewrite a sealed daily active-set or sealed revenue is forward-only. The deliberate exception is `whale_top_percents` (retroactive only because re-ranking a stored distribution needs no raw re-scan — and only if the full distribution is retained).

---

## 8. Open questions

Pulled from [research](../001-analytics-platform/research.md) §6 where these KPIs depend on it, plus new ones surfaced here. Each has a default so /plan isn't blocked.

- **WC-1 — Whale-concentration spine scope [OPEN, scope decision]:** retain the **full per-payer period spend distribution** (enables retroactive `whale_top_percents` re-ranking + arbitrary percentiles, modest spine growth bounded by payer count) vs a **top-k prefix only** (smaller, forward-only percentiles). The one real SC-007 tradeoff. *Recommendation: retain full per-payer per-month spend in v1 (payers ≪ users, so cost is small at indie scale); revisit top-k only if payer volume grows. Flag whale concentration as the sole KPI needing a new maintained aggregate.*
- **WC-2 — Whale small-N masking [LEANING]:** below some payer count (e.g. < 20), top-1% is a single noisy user. *Default: mask/annotate whale share below a config `whale_min_payers` (default 20); still compute, but flag as low-confidence.*
- **DK-1 — MAU window semantics [LEANING]:** rolling-30d (internal grain) vs calendar-month display. *Default: rolling-30d internal (needed for stickiness); calendar-month offered as a display-only reprojection.*
- **DK-2 — Distinct-over-window exactness at scale [LEANING, ties §S-3]:** exact set-union vs HLL for WAU/MAU/period-payers. *Default: exact in v1 (union retained daily distinct-user sets); HLL as the documented scale lever, never for money.*
- **DK-3 — First-purchase-day spine [LEANING]:** first-purchase conversion needs a once-set first-purchase-day per payer. *Default: add a write-once first-purchase-day flag to the payer spine (idempotent, mirrors §B set-once bit); it's tiny and payer-bounded.*
- **DK-4 — Active-user definition alignment [LEANING, inherits §B-1]:** DAU activeness must match retention activeness (`session_start`). *Default: `active = ≥ 1 session-start on the UTC day`, shared with retention; do not diverge.*
- **DK-5 — ARPU denominator period alignment [LEANING]:** ARPU/conversion over a *period* (week/month) need active-user and payer counts over the **same** period as revenue. *Default: always pair a revenue period with the same-length active/payer window (weekly revenue ÷ WAU, monthly ÷ MAU); never mix a daily numerator with a windowed denominator except in the explicitly-defined ARPDAU.*
- **DK-6 — Currency normalization (inherits §D-2) [OPEN]:** all revenue numerators use the monetization sheet's `price_usd` normalization (config FX stamped at purchase date). *Recommendation: inherit §D-2 verbatim; no separate FX policy for derived KPIs.*
- **DK-7 — Refunds (inherits §D-1) [OPEN]:** gross-only v1 means ARPU/ARPPU/whale are **gross** figures. *Recommendation: label KPIs "gross" in v1; when net revenue lands (v2, §D-1), these recompute from the same rollup with refunds subtracted — no new SDK data.*

---

## Cross-references

- **Deeper reference (folded in above):** the derived-KPIs metric sheet — whale-concentration spine scope (WC-1), small-N masking, MAU window semantics, distinct-over-window exactness, gross-vs-net (inherits §D-1), all open questions. Consolidated into this spec; the standalone sheet is retired by this re-homing.
- **Pure consumer:** reuses [003-sessions](../003-sessions/spec.md) (activeness), [005-retention](../005-retention/spec.md) (spine / `first_seen`), [006-monetization](../006-monetization/spec.md) (revenue rollup + payer set). Its only new durable state is the payer-bounded first-purchase flag and per-payer period spend — reconciled against SC-007 in the ledger in the [monetization metrics README](../006-monetization/spec.md).
- **Design:** see [design.md](./design.md), which realizes §4/§5 on the [foundation](../001-analytics-platform/foundation.md) backbone.
