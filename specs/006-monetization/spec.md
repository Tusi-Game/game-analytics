# Segmented Monetization (US4)

**Part of:** [001-analytics-platform](../001-analytics-platform/spec.md)
**Story:** US4 (P2) · **Reserved kind owned:** `purchase` · **Status:** Draft · **Spec refs:** FR-018/019/020/021, FR-027, SC-006, SC-007
**Depends on:** [002-foundation-ingest](../002-foundation-ingest/spec.md) (ingest / raw-event front door), [003-sessions](../003-sessions/spec.md) (`sessions_before_purchase` is a client-SDK counter — consumed, nothing read server-side), [005-retention](../005-retention/spec.md) (`USER_SPINE.first_seen` for server-derivable `days_since_install` / `install_cohort`), [007-derived-kpis](../007-derived-kpis/spec.md) (`PAYER_SPINE_EXT.lifetime_spend_normalized` read for pre-purchase `payer_tier`; fed the purchase-accept signal). Shares the server-SDK trust path with [004-economy](../004-economy/spec.md).

> **Money seam.** The 05→06 handoff (purchase-accept signal, exactly-once atomic unit, payer-tier read-before-write, lifetime-spend tiering) is governed by bridge [05.5-purchase-accept-contract.md](../001-analytics-platform/bridges/05.5-purchase-accept-contract.md). Deeper open-question catalog and shared-convention notes live in the foundation ([../001-analytics-platform/foundation.md](../001-analytics-platform/foundation.md)) and the umbrella spec.

**Excluded here** (→ [design.md](./design.md)): key layouts, DDL, join implementation, ER/data model, Redis structures, worker/pipeline flow.

---

## 1. Story understanding

**The story.** The developer sees not just which package sold most, but which package sold most **to whom / when / in what game-context** — sliced by configurable dimensions (level bucket, region, in-game state, payer tier, days-since-install, sessions-before-purchase) — using **server-verified** purchase data.

**The question it answers.** *"Which package sold most to whom, when, and in what context?"* e.g. "players out of energy at level 12 in region X buy the Energy Refill pack." Segmentation is the differentiator over a plain revenue bar chart — it lets the operator see "players out of energy at level 12 in region X buy the Energy Refill pack."

**Definition (server-truth + client-context join):** per game, over a UTC day, maintain a rollup keyed by **(product × dimension-combo)** producing **purchase count** and **normalized revenue**. Revenue comes **only** from server-verified purchase rows; the dimension values that segment it come from a **client context-companion event keyed by the SDK-minted `purchase_attempt_id`**, joined onto the server row (money still dedups durably by `transaction_id`). "Top package by `<D>`" = for a fixed dimension `D`, rank products by their summed measure within each value of `D`.

- **Money truth = server row.** The server SDK emits the authoritative revenue row (real money, verified receipt). The client SDK emits a **zero-money companion keyed by the SDK-minted `purchase_attempt_id`**, carrying purchase-time player context. Joined on `purchase_attempt_id` for the segmented rollup (money still dedups durably by `transaction_id`).
- **Companion is enrichment, never a gate.** If it never arrives, the server row **stands alone with reduced dimensions** (server-derivable dims survive; client-only dims render `unknown`). Revenue is never blocked or delayed on context.
- **Rejected variants:**
  - *Client-reported revenue* — rejected: client money is spoofable ("the client is the messenger, not the source of truth"). Client contributes **zero** money.
  - *Denormalize all context onto the server call* — rejected for v1 because it forces the game to re-plumb every context field onto the server call; the companion-join pattern (RevenueCat subscriber-attributes style) keeps money strictly server-sourced without that plumbing.
  - *Reconcile-by-`transaction_id` money merge* — deferred; v1 carries `source` / `verified` / `original_transaction_id` so it's a clean later upgrade.

**What it means for the operator.** Actionable "who buys what, and in what moment" — with a first-class `unknown` slice showing how much revenue lacks context (companion-delivery health).

---

## 2. How it is calculated

**Bucketing.** The platform **logical day** (Foundation §4.7 — `utc_day(corrected + reporting_offset)`, single platform timezone; every "UTC day" below reads as the logical day) of the server row's skew-corrected event-time. Segment grain = **(product × active-dimension-combo)** per logical day.

**Measures per cell (per game / product / dimension-combo / UTC day):**
- `purchase_count` = number of distinct **server-verified, prod** purchases (deduped by `transaction_id`).
- `normalized_revenue` = Σ over those purchases of `price_local × fx_rate(currency, purchase_UTC_date)`.

**Eligibility (a purchase counts iff):** `source=server` AND `verified=true` AND `environment=prod` AND not already-seen `transaction_id`. `refunded=true` rows still count in **gross** v1 (flag carried for v2 net).

**Dimension resolution:** join server row ← companion on `purchase_attempt_id`. Per active dimension: use the companion value if present; else the server-derivable value if the dimension is server-derivable (`payer_tier`, `install_cohort`); else `unknown`. **Exception — `days_since_install` is server-wins**: it is server-derivable from `first_seen` and the more trustworthy source, so the server value takes precedence over any companion value (the companion's `days_since_install` is used only when the server cannot derive it). `sessions_before_purchase` and `in_game_state` are **client-only** → `unknown` when the companion is missing.

**Top package by `<D>`:** for a chosen dimension `D` and reporting period, for each value `v` of `D`: `top_product(D=v) = argmax_product Σ measure` over cells matching `(product, D=v)`, marginalizing the other dimensions.

### Worked example

Config: `monetization_dimensions = [region, in_game_state]`, `normalization_currency = USD`; FX stamped at purchase date: `USD→1.00`, `EUR→1.10`, `IRR→0.0000230`. Level bucket irrelevant here.

**Purchase stream (one UTC day). All server rows unless noted; all `verified=true`, `prod` unless noted.**

| # | txn_id | product | price_local | curr | region (companion) | in_game_state (companion) | notes |
|---|---|---|---|---|---|---|---|
| 1 | T1 | energy_pack | 0.99 USD | USD | EU | out_of_energy | companion present |
| 2 | T2 | energy_pack | 0.90 EUR | EUR | EU | out_of_energy | companion present |
| 3 | T3 | gem_bundle | 4.99 USD | USD | EU | pre_boss | companion present |
| 4 | T4 | energy_pack | 0.99 USD | USD | NA | out_of_energy | companion present |
| 5 | T5 | starter_pack | 2.99 USD | USD | NA | post_defeat | companion present |
| 6 | T6 | gem_bundle | 4.99 USD | USD | NA | pre_boss | companion present |
| 7 | T7 | energy_pack | 0.99 USD | USD | — | — | **companion MISSING** |
| 8 | T4 | energy_pack | 0.99 USD | USD | NA | out_of_energy | **duplicate of T4** (offline retry, arrives later) |
| 9 | T9 | gem_bundle | 4.99 USD | USD | EU | pre_boss | `environment=sandbox` |
| 10 | T10 | gem_bundle | 4.99 USD | USD | EU | pre_boss | `source=client` companion arrived but **no server row** |

**Normalize + filter:**
- Row 8 (T4) — durable `transaction_id` dedup: **dropped, no double-count** (offline retry can arrive *days* later — a Redis 24 h window cannot catch it).
- Row 9 (T9) — `sandbox`: **excluded from revenue**.
- Row 10 (T10) — client companion with no server revenue row: **contributes zero money** (inert).
- Row 7 (T7) — server revenue row, companion missing → **stands alone, reduced dimensions**: `region=unknown`, `in_game_state=unknown`.

Normalized revenue (USD): T1=0.99, T2=0.90×1.10=**0.99**, T3=4.99, T4=0.99, T5=2.99, T6=4.99, T7=0.99.

**(product × region × in_game_state) rollup cells:**

| product | region | in_game_state | count | revenue |
|---|---|---|---|---|
| energy_pack | EU | out_of_energy | 2 (T1,T2) | 1.98 |
| gem_bundle | EU | pre_boss | 1 (T3) | 4.99 |
| energy_pack | NA | out_of_energy | 1 (T4) | 0.99 |
| starter_pack | NA | post_defeat | 1 (T5) | 2.99 |
| gem_bundle | NA | pre_boss | 1 (T6) | 4.99 |
| energy_pack | unknown | unknown | 1 (T7) | 0.99 |

**Top package by `region`** (marginalize `in_game_state`; rank by revenue):
- `region=EU`: energy_pack 1.98, gem_bundle 4.99 → **top = gem_bundle (4.99)**.
- `region=NA`: energy_pack 0.99, starter_pack 2.99, gem_bundle 4.99 → **top = gem_bundle (4.99)**.
- `region=unknown`: energy_pack 0.99 → **top = energy_pack (0.99)** (the reduced-dimension bucket from the missing companion, T7).

**Top package by `in_game_state`** (marginalize `region`; rank by revenue):
- `out_of_energy`: energy_pack 1.98+0.99 = 2.97 → **top = energy_pack (2.97)**.
- `pre_boss`: gem_bundle 4.99+4.99 = 9.98 → **top = gem_bundle (9.98)**.
- `post_defeat`: starter_pack 2.99 → **top = starter_pack (2.99)**.
- `unknown`: energy_pack 0.99 → **top = energy_pack (0.99)** (T7's missing companion).

The missing-companion case (T7) is not lost — its **revenue is fully counted**; only its client-only dimensions degrade to an `unknown` bucket, which is reported as a first-class slice so the operator sees how much revenue lacks context.

**Immature / partial handling:** the current UTC day is provisional until sealed (48 h grace); "top package" for today may shift as more purchases/companions arrive. Sealed days are immutable. A cell whose companions are still landing within the grace window may gain dimension resolution up to seal; after seal, an unmatched companion is quarantined (see §6 edge cases). A late companion can enrich up to seal; sealed days are immutable.

---

## 3. Data needed (input)

Both sides extend the canonical envelope. The **trust boundary is the `source` field**: `source=server` rows are the only revenue truth; `source=client` companion rows carry context and zero money.

### 3a. Server SDK — authoritative revenue row (`kind=purchase`, `source=server`)

The `purchase` reserved typed kind. **Strictly validated (§H)**; a row missing any required field is **quarantined to the raw file**, not counted.

| Field | Meaning | Req? | Source of truth |
|---|---|---|---|
| `transaction_id` | Store-issued unique id (Apple `Transaction.id`, Google order id / purchaseToken). Dedup + join key. | required | Store (via server validation) |
| `original_transaction_id` | Store-issued stable id across renewal/restore (Apple id rotates). | required | Store |
| `product_id` (package id) | The SKU/package sold. | required | Server |
| `product_category` | Coarse category for rollup (`consumable`, `subscription`, `cosmetic`, …). | required | Server |
| `price_local` (raw amount) | Raw local charged amount, **stored separately** from any normalized value. | required | Store |
| `currency` | ISO currency of `price_local`. | required | Store |
| `source` | `client` \| `server`. Here = `server`. Only `server` contributes revenue. | required | SDK |
| `verified` | Server-side receipt validation succeeded. Only `verified=true` counts toward revenue. | required | Server validation |
| `environment` | `prod` \| `sandbox`. **`sandbox` excluded from revenue.** | required | Store |
| `user_id` | Game `user_id` passed to server SDK at validation time (identity↔store mapping). | required | Game→server SDK |
| `refunded` | Gross-only v1 flag; default `false`. Hook for v2 net revenue. | optional | Store notification |
| server-derivable dims | `days_since_install`, `payer_tier` (first/repeat/whale), `install_cohort` — derivable server-side from the user spine / this purchase, so they survive even with no companion. | optional | Server |

**Note:** raw `price_local` + `currency` are stored **separately from any normalized value** — the normalized figure is computed downstream from a config FX table, **never sent by the SDK**.

### 3b. Client SDK — context-companion event (keyed by `purchase_attempt_id`, **zero money**)

Emitted by the client immediately after the store confirms a purchase. Carries **no money field** — it is flagged non-revenue and contributes zero to the revenue measure. It exists solely to supply purchase-time client context that the server cannot see.

| Field | Meaning | Req? | Source of truth |
|---|---|---|---|
| `purchase_attempt_id` | **Join key** — SDK-minted id threaded into the store call, matched to the server row (the client often lacks the store `transaction_id` at purchase-context time). | required | Client SDK |
| `level_bucket` (from `player_level`) | Player level at purchase, bucketed per config boundaries. | optional | Client |
| `region` | Player region at purchase. | optional | Client |
| `in_game_state` | Momentary state: `post_defeat`, `out_of_energy`, `pre_boss`, … | optional | Client |
| `sessions_before_purchase` | **CLIENT-side SDK counter** (per the sessions decision) — sessions this user completed before this purchase. **The server does NOT derive this** (no per-user session history under results-only). Stamped by the client SDK onto this companion event. | optional | **Client SDK counter** |
| `days_since_install` | Client's view (server may also derive its own; **server value wins** if both present). | optional | Client |

Companion rows are **not** revenue rows: they never dedup money, never create a rollup cell on their own, and are dropped from revenue math entirely. A companion with no matching server row is inert (held only long enough for a possibly-late server row, then discardable — see §6). The normalized figure is computed downstream from a config FX table — **never sent by the SDK**.

---

## 4. Data stored for longer-run processing

### Data-shape requirements (WHAT must be derivable — NOT how it's stored)

- **Monetization rollup (result):** *per game × product × active-dimension-combo × UTC day, we must be able to produce* `purchase_count` and `normalized_revenue`. This is the FR-019 rollup; "top package by `<D>`" is a marginalize-and-rank read over it. Grain includes an explicit `unknown` value per dimension for reduced-dimension (missing-companion) purchases.
- **Purchase idempotency spine (durable, minimal, money-only):** *per `transaction_id`, we must be able to answer "seen before?"* — carrying `original_transaction_id` and a minimal ref. This is **uniqueness keys, not an event log** (FR-010) — permitted alongside the user spine. Enables durable, never-windowed money dedup.
- **Raw local + currency retained separately** from `normalized_revenue` so re-normalization under a corrected FX table (for **unsealed** days) is possible without re-ingest, and so the normalized figure is always re-derivable from (raw amount, currency, purchase-date FX). An unsealed day can re-normalize under a corrected FX table without re-ingest.
- **`purchase_attempt_id`-keyed context resolution:** *given a server revenue row, we must be able to produce its dimension-combo* by joining the client companion on `purchase_attempt_id`, falling back to server-derivable dims, then `unknown`. The companion holds no durable money and need not persist as an event — only its resolved dimension contribution to the rollup cell must be derivable.
- **Per-payer spine extension (minimal, payer-bounded):** `lifetime_spend_normalized` — one monotonic numeric per payer (write-once, never decremented), keyed per `(game_id, user_id)`. Payer-tier classification (first/repeat/whale) reads this value against operator-configured dollar thresholds at query time; the spine stores only the spend, never the tier. Row-existence is the payer/non-payer boundary — non-payers cost zero. Rebuildable from `PURCHASE_IDEMPOTENCY` + dated FX. Ratified 2026-07-17 (Q3); recorded in the spine-budget ledger (see [../001-analytics-platform/spec.md](../001-analytics-platform/spec.md) — SC-007 ledger). **`sessions_before_purchase` is NOT derived server-side** — it arrives pre-computed on the companion (sessions decision), so no per-user session history is kept. This keeps the money path results-only. `first_seen` (from [005-retention](../005-retention/spec.md)) supports server-side `days_since_install` / `install_cohort`.
- **Computable WITHOUT raw re-scan?** **Yes.** Every measure is an incremental upsert into the rollup at process-time from (server row + joined companion + FX config + idempotency check). No historical raw scan is needed for any live figure. The **only** operation that would need raw is a *retroactive* dimension/bucket re-slice — which is exactly why dimension changes are **forward-only** (FR-020) and the raw file is a manual backfill floor, not a live dependency.

**Durable structures (result-level restatement):**
- **Monetization rollup (result):** per game × product × active-dimension-combo × UTC-day — `purchase_count` and `normalized_revenue`. "Top package by `<D>`" is a marginalize-and-rank read. Grain includes an explicit `unknown` value per dimension for reduced-dimension purchases.
- **Purchase idempotency spine (durable, minimal, money-only):** per `transaction_id` — "seen before?", carrying `original_transaction_id` + a minimal ref. **Uniqueness keys, not an event log** (permitted alongside the user spine). Enables durable, never-windowed money dedup.
- **Raw local + currency retained separately** from `normalized_revenue`, so an unsealed day can re-normalize under a corrected FX table without re-ingest, and the normalized figure is always re-derivable.
- **Per-user spine reuse (minimal):** `first_seen` (from [005-retention](../005-retention/spec.md)) supports server-side `days_since_install` / `install_cohort`. **`sessions_before_purchase` is NOT derived server-side** — it arrives pre-computed on the companion (client counter), so no per-user session history is kept.

---

## 5. Data-structure thinking — Redis & database

*Conceptual shapes only; the realized ER / Redis / worker design lives in [design.md](./design.md).*

**Redis (transient, hot).**
- **Today's rollup accumulators** — per game × product × dimension-combo × today: running count + normalized revenue. Hot; lost on crash (accepted; money truth is not here).
- **Companion staging** — client companions held briefly awaiting a possibly-late server row (and vice-versa), within the 48 h grace, for the `purchase_attempt_id` join.
- (Money dedup is **not** a Redis window — see below.)

**Database (durable, results-only).**
- **Monetization rollup** — durable per game × product × dimension-combo × sealed-day count + revenue. The dashboard reads and marginalizes this.
- **Purchase idempotency table** — the durable `transaction_id` UNIQUE spine; the **authoritative money dedup** (`ON CONFLICT DO NOTHING`), outliving any transient window. This is why an offline purchase retry arriving *days* later never double-counts.
- **Raw local + currency** kept beside normalized revenue for unsealed re-normalization.

**The bridge.** Hot rollup accumulators flush to durable results on the cadence (idempotent absolute upsert). But the **money-correctness guarantee lives in the durable `transaction_id` spine, not Redis** — the sharp contrast with non-money events (which tolerate a 24 h window and rare beyond-window double-count). Revenue truth (durable results + idempotency spine + write-ahead raw file) is never in Redis, so a Redis loss never counts-but-unlogs a purchase. Losing Redis loses at most ≤5 min of un-flushed rollup drift and today's live counters; the durable money spine and completed raw file survive.

---

## 6. Configurations

| Knob | Default | Range / values | Forward / retro |
|---|---|---|---|
| `monetization_dimensions` | `[level_bucket, region, in_game_state, payer_tier]` | any subset of `level_bucket`, `region`, `in_game_state`, `payer_tier`, `days_since_install`, `sessions_before_purchase` | **Forward-only (rebuild-forward, FR-020).** Changing the set re-keys rollup cells; sealed rollups keep their old keys. Re-slicing history needs a forbidden raw re-scan (the raw file is only a manual backfill floor). |
| `level_bucket_boundaries` | operator-set (e.g. `[1,5,10,20,50]`) | ascending cut points | **Forward-only** — re-bucketing history would rewrite sealed cells. |
| `fx_table` | operator-supplied, **stamped at purchase date** | per-currency dated rate | **Forward-only for sealed days** — a day's normalized revenue uses the as-of-date rate; sealed days are not re-normalized when the table later changes. |
| `normalization_currency` | operator-set (e.g. `USD`) | single target currency | Forward-only for sealed days (paired with `fx_table`). |
| `sandbox_excluded` | `true` | bool | Applies at ingest classification; `environment=sandbox` never enters revenue. |
| `payer_tier_rule` | first / repeat / whale by cumulative spend | operator thresholds | Forward-only if it changes how a purchase is tiered at count-time. |

**Inherited globals:** dedup posture (§F), day-seal grace 48 h, flush cadence 5 min.

---

## 7. Open questions

Pulled from research §6 (§D-1..5) plus items this metric surfaces. Each has a default so `/plan` isn't blocked.

- **§D-1 Refunds / chargebacks [OPEN]:** subtract (net) or gross-only? Refunds arrive via App Store Server Notifications V2 / Play RTDN. *Default: gross-only in v1; carry `refunded` flag + a notification hook for v2 net revenue. Rollup revenue is gross; do not retro-subtract sealed days.*
- **§D-2 Currency normalization ownership [OPEN]:** who owns the FX table and its as-of date? *Default: store raw `price_local` + `currency` always; normalize via operator-supplied config FX table **stamped at purchase UTC date**; defer live FX. Sealed days are not re-normalized.*
- **§D-4 Identity ↔ store-transaction mapping [OPEN]:** Apple `appAccountToken` isn't guaranteed. *Default: game passes `user_id` to the server SDK at validation time; store it on the purchase row (needed for `payer_tier`, `days_since_install`).*
- **§D-3 / §D-5 [LEANING]:** sandbox excluded via `environment` field; missing companion → reduced-dimension revenue that still counts. Adopted above; confirm.
- **New — Companion retention / orphan TTL:** how long is an unmatched companion held for a possibly-late server row before discard, and vice-versa? *Default: hold within the 48 h day-seal grace; after seal, unmatched companions quarantine, unmatched-server rows already counted. Aligns to §G.*
- **New — `sessions_before_purchase` trust & reset semantics:** it is a **client counter** (sessions decision) — spoofable and reset-on-reinstall. *Default: accept as a low-trust dimension for slicing only (never money); document that it is client-authored and not server-verifiable; treat missing as `unknown`.*
- **New — `in_game_state` vocabulary:** free-form client string risks cardinality sprawl across games. *Default: accept-all but subject to the per-dimension-value cardinality guardrail (mirror §H-4's name-cap posture); operator may later constrain to an allowed set per game.*
- **New — Reduced-dimension `unknown` reporting:** should the dashboard surface "% of revenue with full context" so the operator knows how much sits in `unknown` buckets? *Default: yes — expose a context-coverage figure; it directly signals companion-delivery health.*

---

## Cross-references

- Deeper open-question detail: companion orphan TTL, refunds/net-revenue (§D-1), FX ownership (§D-2), identity↔store mapping (§D-4), `in_game_state` vocabulary, context-coverage reporting — see the umbrella research and foundation ([../001-analytics-platform/research.md](../001-analytics-platform/research.md), [../001-analytics-platform/foundation.md](../001-analytics-platform/foundation.md)).
- Design realization (ER, Redis, worker/pipeline flow, cardinality guard, API/read-model): [design.md](./design.md).
- Money seam (purchase-accept signal, exactly-once, payer-tier ordering, lifetime-spend tiering): bridge [05.5-purchase-accept-contract.md](../001-analytics-platform/bridges/05.5-purchase-accept-contract.md).
- Feeds **[007-derived-kpis](../007-derived-kpis/spec.md)** (revenue rollup + payer set are the numerators for ARPU/ARPPU/ARPDAU/whale). Consumes **[003-sessions](../003-sessions/spec.md)** (`sessions_before_purchase`) and **[005-retention](../005-retention/spec.md)** (`first_seen` for server-derivable dims).
