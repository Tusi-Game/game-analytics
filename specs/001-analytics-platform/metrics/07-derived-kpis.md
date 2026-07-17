# Metric Spec Sheet: Derived KPIs (DAU/MAU, ARPU/ARPPU/ARPDAU, Conversion, Whale Concentration)

**Feature**: 001-analytics-platform · **Phase**: research/specify · **Status**: Draft
**Depends on**: SESSIONS decision (LOCKED) · §B retention "active"-definition (§B-1) · §D purchase truth · Monetization sheet (revenue rollup) · Retention sheet (active-user / cohort results) · §G event-time · §F dedup

## 1. Purpose & Definition

This sheet answers the operator's "how healthy and how profitable is the game overall?" questions with the composite KPIs every game dashboard reports: how many distinct players are active (DAU/WAU/MAU), how habitual they are (stickiness), how much money each player type produces (ARPU/ARPPU/ARPDAU), what fraction of players pay (conversion), and how concentrated revenue is among the biggest spenders (whale concentration). These are **derived** metrics: they are computed **from the results the other metric engines already maintain** — the session/active-user counts, the retention spine, and the monetization revenue rollup — plus a small denominator spine. Almost none of them need their own SDK event.

**Definitions (chosen variants):**
- **DAU / WAU / MAU** = **distinct active `user_id`s** with ≥1 qualifying session in the period. "Active" reuses the SESSIONS + §B-1 definition: a `session` event whose **START day (UTC)** falls in the period (the session-start UTC day is the activeness anchor; §G). DAU is an **exact distinct-per-UTC-day** count; WAU/MAU are **distinct-over-a-window** (7 / 30 rolling UTC days ending on the report day) — distinctness must hold *across* the days, so a user active on 12 of 30 days counts once in MAU.
  - *Rejected*: "active = any event" (over-counts background/telemetry pings; inconsistent with retention which is session-anchored — §B-1 default is "≥1 `session` event"). We align DAU with retention activeness so the two dashboards never disagree.
  - *Rejected*: calendar-month MAU (Jan-1…Jan-31). We use **rolling 30-day** MAU (trailing window) as the default because stickiness (DAU/MAU) is only meaningful on a rolling window; calendar MAU is offered as a display variant, not the internal grain.
- **Stickiness** = DAU / MAU (both on the same report day; MAU = trailing 30d). Range (0,1]; higher = users return more days per month. A common "sticky" bar is ≈0.2 (active 6 of 30 days).
- **ARPU** = normalized revenue in period ÷ **active users** in the same period (all active, payers and non-payers).
- **ARPPU** = normalized revenue in period ÷ **paying users** (distinct users with ≥1 verified prod purchase) in the same period. ARPPU ≥ ARPU always.
- **ARPDAU** = **daily** normalized revenue ÷ **DAU** for that UTC day. The day-grain ARPU; the most-watched monetization pulse.
- **Conversion rate (payer conversion)** = distinct **paying users** ÷ distinct **active users** in the period. **First-purchase conversion** = distinct users whose **first-ever** verified purchase fell in the period ÷ active (or new) users in the period — a flow rate, not a stock ratio.
- **Whale concentration** = share of period revenue produced by the **top X% of payers** ranked by spend (default report X ∈ {1%, 5%, 10%}). Requires a **per-payer revenue distribution** for the period — the one KPI here that needs a *new maintained aggregate* (see §5).
- *(Optional)* **New users** = distinct users whose `first_seen` (UTC day) is in the period. **Returning users** = active users in period whose `first_seen` predates the period. **DAU composition** = DAU split into new vs returning (new + returning = DAU, disjoint by construction).

## 2. SDK Data Captured

**These KPIs add essentially NO new SDK event.** They consume fields already required by the sessions, retention, and monetization sheets. Enumerated as *uses of* the canonical envelope, not additions:

| Field | Meaning | Req/Opt | Source of truth | Used for |
|---|---|---|---|---|
| `user_id` | stable player id (envelope) | required | client (game-provided) | distinct-count key for DAU/WAU/MAU, active/paying denominators |
| `session` event + `session_start_time` | start day (UTC) sets activeness (SESSIONS + §B-1) | required | **client SDK** (session is SDK-managed) | active-user membership (DAU/WAU/MAU, ARPU/ARPDAU/conversion denominators) |
| purchase revenue row: `transaction_id`, normalized amount, `verified`, `environment`, `source` | server-verified money (§D) | required | **server SDK** (revenue is server-only) | numerators of ARPU/ARPPU/ARPDAU; payer set; per-payer spend for whale concentration |
| `is_first_purchase` / first-purchase detection | flags a payer's first-ever verified purchase | derived | **server-side** (first verified txn per `user_id`) | first-purchase conversion, new-payer flow |
| `first_seen` (user spine) | install-day anchor | required | server-derived on first session | new vs returning composition |

**Trust boundary (critical):** every **numerator that is money** (ARPU/ARPPU/ARPDAU revenue, per-payer spend) is **server-sourced only** (§D — "client is the messenger, not the money source of truth"; sandbox `environment` excluded, only `verified` prod purchases). Every **denominator that is an active-user count** comes from the **client-SDK session** stream (activeness is a client concept). The **payer set** is server-derived (a user is a payer iff they have ≥1 verified prod purchase). No KPI here trusts a client-reported revenue or a client-reported "is_payer" flag for the money side.

## 3. Admin Configuration

| Knob | Default | Range / values | Retro or Forward |
|---|---|---|---|
| `mau_window_days` | 30 | 28–31 (and 7 for WAU, 1 for DAU are fixed) | **Forward-only** for sealed daily active-sets; changing the window only re-slices already-maintained per-day active data if that data is retained (see §5) — otherwise forward-only. |
| `whale_top_percents` | [1, 5, 10] | any subset of 1–50 (integers) | **Retroactive IF** per-payer period spend is retained (it is a re-rank of an existing distribution, no re-scan); forward-only if only the top-k prefix is retained. This is the §5 scope tradeoff. |
| `active_definition` | `session_start` | `session_start` (v1-locked; `any_event` is **v2-only**) | **Locked to `session_start` in v1** (inherits §B-1, which forbids generic events marking activeness — see retention sheet §7). The `any_event` alternative is deferred to v2 alongside the optional per-game "qualifying action"; it is NOT an operator-settable knob in v1. |
| `arppu_first_purchase_denominator` | `active_users` | `active_users` \| `new_users` | Forward-only (display choice; affects first-purchase conversion base). |
| `revenue_currency` | (inherits monetization `price_usd` normalization, §D-2) | config FX table | Forward-only (FX stamped at purchase date per §D-2; no retro re-conversion). |
| `partial_window_mask` | on | on \| off | Display-only; masks WAU/MAU/stickiness until the trailing window has fully elapsed. |

Default assumption honored: anything that would rewrite a **sealed** daily active-set or sealed revenue is **forward-only**. The one deliberate exception is `whale_top_percents`, which is retroactive *only because* re-ranking an already-stored per-payer distribution needs no raw re-scan — and only if we choose to retain that distribution (Open Question WC-1).

## 4. Calculation

All time-bucketing is **UTC day** (§G). A "day" is a UTC calendar day; WAU = trailing 7 UTC days ending on the report day; MAU = trailing 30. Cohort/segment grain for v1 headline KPIs is **whole-game** (per `game_id`); segmentation by monetization dimensions is a monetization-sheet concern and out of scope here. All money is normalized revenue (§D-2), prod + verified only.

**Formulas (definitional):**
```
DAU(d)          = |{ user_id : a session STARTED on UTC day d }|
WAU(d)          = |{ user_id : a session STARTED in [d-6 .. d] }|          (distinct across 7 days)
MAU(d)          = |{ user_id : a session STARTED in [d-29 .. d] }|         (distinct across 30 days)
Stickiness(d)   = DAU(d) / MAU(d)
Revenue(period) = Σ normalized_amount over verified prod purchases in period
PayingUsers(P)  = |{ user_id : ≥1 verified prod purchase in period P }|    (distinct)
ARPU(P)         = Revenue(P) / ActiveUsers(P)
ARPPU(P)        = Revenue(P) / PayingUsers(P)
ARPDAU(d)       = Revenue(d) / DAU(d)
Conversion(P)   = PayingUsers(P) / ActiveUsers(P)
FirstConv(P)    = |{ user_id : first-ever verified purchase in P }| / ActiveUsers(P)
WhaleShare(X,P) = ( Σ spend of top ⌈X% · PayingUsers(P)⌉ payers ) / Revenue(P)
NewUsers(P)     = |{ user_id : first_seen ∈ P }|
Returning(P)    = ActiveUsers(P) − NewUsers-active-in-P
```

**Worked example — one UTC day `d` (game G):**
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

**Worked example — whale concentration (period P, game G):**
PayingUsers(P) = **10**, sorted spend descending:
`[$500, $200, $120, $80, $40, $30, $15, $10, $3, $2]`, Revenue(P) = **$1,000**.
- Top **10%** = ⌈0.10·10⌉ = 1 payer → $500 → **50.0%** of revenue.
- Top **20%** = 2 payers → $500+$200 = $700 → **70.0%**.
- Top **50%** = 5 payers → $500+$200+$120+$80+$40 = $940 → **94.0%**.
This is the classic whale-heavy shape (one whale = half the revenue) and is *only* computable if the **per-payer spend distribution for P is available** (see §5 / Open Questions).

**Worked example — DAU composition:**
DAU = 1,000; of those, 150 have `first_seen == d` → **New = 150, Returning = 850** (disjoint; sum = DAU).

**Immature / partial-window handling:** WAU on a game with <7 days of data, and MAU/stickiness with <30 days, render **N/A / masked** (per `partial_window_mask`), never a low number — same discipline as §B-2 immature-cohort masking. ARPDAU/conversion for **today** are provisional (Redis-live, last ~5 min may lag; §E-2) and should carry the "provisional" note; sealed prior days are exact.

## 5. Data-Shape Requirements (WHAT must be derivable — NOT how it's stored)

The governing claim: **every KPI here is computable from results the other engines already maintain plus a minimal denominator spine — WITHOUT a raw event re-scan.** Breakdown by what each needs:

**(a) Active-user counts (DAU/WAU/MAU) — reuse the session/active-user result.**
Per `game_id` per UTC day, we must be able to produce **the set (or exact distinct count) of active `user_id`s** whose session started that day. DAU is exact-per-day (a single day's distinct set). WAU/MAU require distinctness **across a window**, i.e. the union of daily active-sets over 7/30 days de-duplicated. So the derivable shape is: *per game×UTC-day, the distinct active-user set for that day* (from which any trailing window is a set-union). This is the **same activeness data the retention spine already establishes** (session-start bit); DAU/WAU/MAU are a reprojection of it by day rather than by cohort-offset. **No new raw scan.**

**(b) Revenue numerators — reuse the monetization revenue rollup.**
Per `game_id` per UTC day, we must be able to produce **total normalized verified-prod revenue** (already maintained by the monetization sheet as the day/product rollup — sum over products gives the daily total). Period revenue = sum of daily totals. **No new aggregate.**

**(c) Paying-user counts — a distinct-payer count per period.**
Per `game_id` per UTC day, we must be able to produce **the distinct set (or count) of `user_id`s with ≥1 verified prod purchase that day**, so period PayingUsers is a window-union like MAU. The purchase idempotency spine (`transaction_id`→user, already durable per §D/§F, allowed alongside results-only) can source distinct payers without a raw scan. **First-purchase** needs a per-user "first verified purchase day" — derivable as a **once-set flag on the payer's first appearance** (analogous to the retention set-once bit; write-once, idempotent). This is a **minimal** payer-spine addition (one first-purchase-day per paying user), justified because first-purchase conversion is a headline KPI and it cannot be re-derived from results-only otherwise.

**(d) Whale concentration — the one KPI *within this sheet* that needs a NEW maintained aggregate.** (Across the whole platform it is one of several per-user/per-payer spine draws — see the spine-budget ledger in `metrics/README.md`, which reconciles funnel progress (06), economy last-known balance (02), and the two payer-spine fields here against SC-007.)
Whale share needs a **per-payer cumulative spend for the period** (to rank and take the top X%). Daily revenue totals are insufficient — the distribution is lost once summed. The minimal derivable shape is: **per `game_id` per period (e.g. per rolling/calendar month), per paying `user_id`, cumulative normalized verified-prod spend.** This is a **per-payer aggregate**, wider than the pure result grain. Honest tradeoff vs **SC-007** (Postgres holds only results + minimal spine): this stays results-only in *kind* (it is an aggregate, not raw events) and is bounded by **payer count, not user count** — payers are a small fraction of users (conversion ≈ few %), so at indie scale this is thousands of rows/period, not millions. It **does modestly expand the spine** beyond "a handful of small columns per user." Two containment options for /plan (Open Question WC-1): (i) retain the full per-payer period spend distribution (enables retroactive `whale_top_percents` re-ranking, richer percentiles); or (ii) retain only a **top-k prefix** (e.g. top 100 spenders/period) — much smaller, but fixes the reportable percentiles forward-only and can't answer an arbitrary later X%.

**Distinct-count over a window (a + c) — exact-vs-approximate tension (consistent with sessions §S-3).**
DAU is trivially exact (one day). WAU/MAU/period-payers require **distinct-over-a-window** counts whose exact form is a set-union of daily active/payer sets. Per the sessions sheet's §S-3 posture: **v1 keeps these EXACT** (union the retained daily distinct-user sets — feasible at indie scale). **HyperLogLog (HLL) is the named scale lever**, not a v1 default: per-day HLL sketches merge to give approximate WAU/MAU/period-payers cheaply if daily distinct-set retention becomes too large. Flag as forward-compatible, mirroring §S-3's "exact in v1, HLL as scale lever." (Never approximate the **money** numerators — those are exact sums; approximation only ever touches distinct-user *counts*.)

**Net verdict:** DAU/WAU/MAU, stickiness, ARPU/ARPPU/ARPDAU, conversion are **v1-trivial** — they fall straight out of existing session-active results + monetization revenue rollup + a distinct-payer count. **Whale concentration** requires a **new per-payer-cumulative-spend aggregate** (the only genuine spine expansion). **First-purchase conversion** needs a minimal once-set first-purchase-day flag on the payer spine.

## 6. Edge Cases & Failure Modes

- **Distinct-count over a window (WAU/MAU/payers) double-count**: a user active on multiple days must count **once**. Guaranteed by the set-union / distinct semantics; consistent with §B's set-once bitmap idempotence. Duplicate-delivered sessions (§F `event_id` 24h window) don't inflate distinct sets — the same `user_id` collapses regardless.
- **Sealed / late events (§G)**: DAU/ARPDAU/whale for a **sealed** UTC day are frozen; a session or purchase arriving >48h late for a sealed day is **quarantined to the raw file**, never folded in — so a headline KPI for a sealed day never silently shifts (preserves §B/§G immutability). Today's KPIs remain mutable within the 48h grace.
- **Clock skew (§G)**: activeness day = skew-corrected client session-start UTC day; a future-dated session clamps to server-now before its day is assigned, so it can't wrongly inflate a future DAU. Money uses server-received purchase time (server-trusted), immune to client skew.
- **Redis loss (§E)**: today's live DAU/ARPDAU/conversion counters are transient (accept-loss); sealed prior-day KPIs are Postgres-durable (flushed ≤5 min). A `today` KPI shown from Redis-live carries the "provisional" note (§E-2). Whale concentration is a period aggregate, not a hot counter — read from durable results, unaffected by Redis loss.
- **Missing client context companion (§D-5)**: does **not** affect these KPIs — they need only the **server revenue row** (amount + user) for numerators and the **session** for denominators, never the client context dimensions. A purchase with no companion still counts fully in ARPU/ARPPU/ARPDAU/whale.
- **Sandbox / unverified purchases (§D)**: excluded from every revenue numerator and from the payer set (`environment=sandbox` or `verified=false` never counts) — so ARPPU/conversion/whale reflect real money only.
- **Division-by-zero / small-N**: DAU=0 ⇒ ARPDAU/stickiness N/A (not 0); PayingUsers=0 ⇒ ARPPU N/A; a whale percentile ⌈X%·payers⌉ that rounds to 0 with 0 payers ⇒ N/A. Very-small payer counts make whale share noisy — mask or annotate below a min-payer threshold (Open Question WC-2).
- **`user_id` reuse / anon→identified**: distinct counts key on the final game-provided `user_id`; session_id is stable across an anon→user transition within a session (SESSIONS decision), so a login mid-session does not create a phantom second active user. Anon↔user merge remains out of scope (v1) — a pre-login anon that never logs in counts as its own active user.

## 7. Open Questions

Pulled from research §6 where these KPIs depend on them, plus new ones surfaced here. Each has a default so /plan isn't blocked.

- **WC-1 — Whale-concentration spine scope [OPEN, scope decision]**: retain the **full per-payer period spend distribution** (enables retroactive `whale_top_percents` re-ranking + arbitrary percentiles, modest spine growth bounded by payer count) vs a **top-k prefix only** (smaller, forward-only percentiles). This is the one real SC-007 tradeoff. *Recommendation: retain full per-payer per-month spend in v1 (payers ≪ users, so cost is small at indie scale); revisit top-k only if payer volume grows. Flag whale concentration as the sole KPI needing a new maintained aggregate.*
- **WC-2 — Whale small-N masking [LEANING]**: below some payer count (e.g. <20), top-1% is a single noisy user. *Default: mask/annotate whale share below a config `whale_min_payers` (default 20); still compute, but flag as low-confidence.*
- **DK-1 — MAU window semantics [LEANING]**: rolling-30d (internal grain) vs calendar-month display. *Default: rolling-30d internal (needed for stickiness); calendar-month offered as a display-only reprojection.*
- **DK-2 — Distinct-over-window exactness at scale [LEANING, ties §S-3]**: exact set-union vs HLL for WAU/MAU/period-payers. *Default: exact in v1 (union retained daily distinct-user sets); HLL as the documented scale lever, never for money.*
- **DK-3 — First-purchase-day spine [LEANING]**: first-purchase conversion needs a once-set first-purchase-day per payer. *Default: add a write-once first-purchase-day flag to the payer spine (idempotent, mirrors §B set-once bit); it's tiny and payer-bounded.*
- **DK-4 — Active-user definition alignment [LEANING, inherits §B-1]**: DAU activeness must match retention activeness (`session_start`). *Default: `active = ≥1 session-start on the UTC day`, shared with retention; do not diverge.*
- **DK-5 — ARPU denominator period alignment [LEANING]**: ARPU/conversion over a *period* (week/month) need active-user and payer counts over the **same** period as revenue. *Default: always pair a revenue period with the same-length active/payer window (weekly revenue ÷ WAU, monthly ÷ MAU); never mix a daily numerator with a windowed denominator except in the explicitly-defined ARPDAU.*
- **DK-6 — Currency normalization (inherits §D-2) [OPEN]**: all revenue numerators use the monetization sheet's `price_usd` normalization (config FX stamped at purchase date). *Recommendation: inherit §D-2 verbatim; no separate FX policy for derived KPIs.*
- **DK-7 — Refunds (inherits §D-1) [OPEN]**: gross-only v1 means ARPU/ARPPU/whale are **gross** figures. *Recommendation: label KPIs "gross" in v1; when net revenue lands (v2, §D-1), these recompute from the same rollup with refunds subtracted — no new SDK data.*
