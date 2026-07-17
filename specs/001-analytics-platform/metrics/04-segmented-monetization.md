# Metric Spec Sheet: Segmented Monetization

**Feature**: 001-analytics-platform · **Phase**: research/specify · **Status**: Draft
**Depends on**: §D (purchase truth = server-only revenue + client context-companion), §F (durable `transaction_id` dedup), §G (skew-corrected UTC event-time / 48h seal), §H (strict validation of the `purchase` reserved kind), the SESSIONS DECISION (`sessions_before_purchase` is a CLIENT-side counter), FR-018/019/020/021, US4. Consumes the same envelope + config-driven dimensions as the retention and economy sheets.

## 1. Purpose & Definition

Answers **not "which package sold most" but "which package sold most to whom, when, and in what game-context"** — top package sliced by configurable player-context dimensions (level bucket, region, in-game state, payer tier, days-since-install, sessions-before-purchase), using **server-verified** purchase data only. It is the differentiator over a plain revenue bar chart: it lets the operator see "players out of energy at level 12 in region X buy the Energy Refill pack."

**Definition (chosen variant — two-sided server-truth + client-context join):**
For each game, over a UTC-day time bucket, maintain a rollup keyed by **(product × dimension-combo)** producing **purchase count** and **normalized revenue**. The revenue measure is sourced **only** from server-verified purchase rows (§D); the dimension values that segment that revenue are sourced from a **client context-companion event keyed by `transaction_id`**, joined onto the server row. "Top package by `<dimension>`" = for a fixed dimension, rank products by their summed measure within each value of that dimension.

- **Money truth = server row.** The SERVER SDK emits the authoritative revenue row (real money, verified receipt). The CLIENT SDK emits a **zero-money context-companion event keyed by the same store `transaction_id`**, carrying purchase-time player context. The two are **joined on `transaction_id`** for the segmented rollup.
- **Companion is enrichment, never a gate.** If the companion never arrives, the server revenue row **stands alone with reduced dimensions** (dimensions it can derive server-side survive; client-only context dimensions render as `unknown`). Revenue is never blocked or delayed on context (§D-5).
- **Rejected variants** (tie to §D):
  - *Client-reported revenue* — rejected: client money is spoofable ("the client is the messenger, not the source of truth"). Client contributes **zero** money.
  - *Denormalize all context onto the server purchase* (research §D domain note) — rejected for v1 because it forces the game to re-plumb every context field onto the server call; the companion-join pattern (RevenueCat subscriber-attributes style) keeps money strictly server-sourced without that plumbing.
  - *Reconcile-by-`transaction_id` (merge client+server money)* — deferred; v1 carries the fields (`source`, `verified`, `original_transaction_id`) so this is a clean later upgrade (§D decision (c)).

## 2. SDK Data Captured

Both sides extend the canonical envelope. The **trust boundary is the `source` field**: `source=server` rows are the only revenue truth; `source=client` companion rows carry context and zero money.

### 2a. SERVER SDK — authoritative revenue row (`kind=purchase`, `source=server`)

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
| `environment` | `prod` \| `sandbox`. **`sandbox` excluded from revenue** (§D-3). | required | Store |
| `user_id` | Game `user_id` passed to server SDK at validation time (identity↔store mapping, §D-4). | required | Game→server SDK |
| `refunded` | Gross-only v1 flag; default `false`. Hook for v2 net revenue (§D-1). | optional | Store notification |
| server-derivable dims | `days_since_install`, `payer_tier` (first/repeat/whale), `install_cohort` — derivable server-side from the user spine / this purchase, so they survive even with no companion. | optional | Server |

**Note:** raw `price_local` + `currency` are stored **separately from any normalized value** — the normalized figure (§4/§D-2) is computed downstream from a config FX table, never sent by the SDK.

### 2b. CLIENT SDK — context-companion event (keyed by `transaction_id`, **zero money**)

Emitted by the client immediately after the store confirms a purchase. Carries **no money field** — it is flagged non-revenue and contributes zero to the revenue measure. It exists solely to supply purchase-time client context that the server cannot see.

| Field | Meaning | Req? | Source of truth |
|---|---|---|---|
| `transaction_id` | **Join key** — same store id as the server row. | required | Store (client-side) |
| `level_bucket` (from `player_level`) | Player level at purchase, bucketed per config boundaries. | optional | Client |
| `region` | Player region at purchase. | optional | Client |
| `in_game_state` | Momentary state: `post_defeat`, `out_of_energy`, `pre_boss`, … | optional | Client |
| `sessions_before_purchase` | **CLIENT-side SDK counter** (per SESSIONS DECISION) — sessions this user completed before this purchase. **The server does NOT derive this** (no per-user session history under results-only). Stamped by the client SDK onto this companion event. | optional | **Client SDK counter** |
| `days_since_install` | Client's view (server may also derive its own; server value wins if both present). | optional | Client |

Companion rows are **not** revenue rows: they never dedup money, never create a rollup cell on their own, and are dropped from revenue math entirely. A companion with no matching server row is inert (held only long enough for a possibly-late server row, then discardable — see §6 §D-companion).

## 3. Admin Configuration

| Knob | Default | Range/values | Retroactive or forward? |
|---|---|---|---|
| `monetization_dimensions` | `[level_bucket, region, in_game_state, payer_tier]` | any subset of the supported context dimensions: `level_bucket`, `region`, `in_game_state`, `payer_tier`, `days_since_install`, `sessions_before_purchase` | **Forward-only (rebuild-forward, FR-020).** Changing the active dimension set re-keys rollup cells; sealed historical rollups keep their old dimension keys. Justification: sealed aggregates are immutable (§B/§G), and re-slicing history requires a raw re-scan (forbidden; the raw file is only a manual backfill floor). |
| `level_bucket_boundaries` | operator-set (e.g. `[1,5,10,20,50]`) | ascending level cut points | **Forward-only.** Re-bucketing history would rewrite sealed cells. |
| `fx_table` (§D-2) | operator-supplied, **stamped at purchase date** | per-currency→normalized-unit rate, dated | **Forward-only for sealed days.** A day's normalized revenue uses the FX rate as-of that purchase's UTC date; once sealed it is not re-normalized when the table is later updated. |
| `normalization_currency` | operator-set (e.g. `USD`) | single target currency | Forward-only for sealed days (paired with `fx_table`). |
| `sandbox_excluded` | `true` | bool | Applies at ingest classification; `environment=sandbox` never enters revenue (§D-3). |
| `payer_tier_rule` | first / repeat / whale by cumulative spend | operator thresholds | Forward-only if it changes how a purchase is tiered at count-time. |

Inherited/global knobs referenced (not redefined here): dedup posture (§F), day-seal grace 48h (§G), flush cadence 5 min (§E).

## 4. Calculation

**Bucketing:** UTC day, per §G — the purchase is attributed to the **UTC day of its skew-corrected event-time** (server row's corrected time). Segment grain = **(product × active-dimension-combo)** per UTC day.

**Measures per rollup cell** (per game / product / dimension-combo / UTC day):
- `purchase_count` = number of distinct **server-verified, prod** purchases (deduped by `transaction_id`, §F).
- `normalized_revenue` = Σ over those purchases of `price_local × fx_rate(currency, purchase_UTC_date)`.

**Eligibility filter (a purchase counts iff):** `source=server` AND `verified=true` AND `environment=prod` AND not already-seen `transaction_id`. `refunded=true` rows still count in **gross** v1 (flag carried for v2 net; §D-1).

**Dimension resolution per purchase:** join server row ← companion row on `transaction_id`. For each active dimension: use the companion value if present; else the server-derivable value if the dimension is server-derivable (`payer_tier`); else `unknown`. **Exception — `days_since_install` is server-wins**: it is server-derivable from `first_seen` and the more trustworthy source, so the server value takes precedence over any companion value (the companion's `days_since_install` is used only when the server cannot derive it). `sessions_before_purchase` and `in_game_state` are **client-only** → `unknown` when the companion is missing.

**Top package by `<D>`:** for a chosen dimension `D` and reporting period, for each value `v` of `D`: `top_product(D=v) = argmax_product Σ measure` over cells matching `(product, D=v)`, marginalizing the other dimensions.

---

### Worked example

Config: `monetization_dimensions = [region, in_game_state]`, `normalization_currency = USD`, FX stamped at purchase date: `USD→1.00`, `EUR→1.10`, `IRR→0.0000230`. Level bucket irrelevant here.

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
- Row 8 (T4) — durable `transaction_id` dedup (§F): **dropped, no double-count.**
- Row 9 (T9) — `sandbox`: **excluded from revenue** (§D-3).
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
- `region=unknown`: energy_pack 0.99 → **top = energy_pack (0.99)** (this is the reduced-dimension bucket from the missing companion, T7).

**Top package by `in_game_state`** (marginalize `region`; rank by revenue):
- `out_of_energy`: energy_pack 1.98+0.99 = 2.97 → **top = energy_pack (2.97)**.
- `pre_boss`: gem_bundle 4.99+4.99 = 9.98 → **top = gem_bundle (9.98)**.
- `post_defeat`: starter_pack 2.99 → **top = starter_pack (2.99)**.
- `unknown`: energy_pack 0.99 → **top = energy_pack (0.99)** (T7's missing companion).

The missing-companion case (T7) is not lost — its **revenue is fully counted**; only its client-only dimensions degrade to an `unknown` bucket, which is reported as a first-class slice so the operator sees how much revenue lacks context.

**Immature/partial handling:** the current UTC day is provisional until sealed (48h grace, §G); "top package" for today may shift as more purchases/companions arrive. Sealed days are immutable. A cell whose companions are still landing within the grace window may gain dimension resolution up to seal; after seal, an unmatched companion is quarantined (§6).

## 5. Data-Shape Requirements (WHAT must be derivable — NOT how it's stored)

- **Monetization rollup (result):** *per game × product × active-dimension-combo × UTC day, we must be able to produce* `purchase_count` and `normalized_revenue`. This is the FR-019 rollup; "top package by `<D>`" is a marginalize-and-rank read over it. Grain includes an explicit `unknown` value per dimension for reduced-dimension (missing-companion) purchases.
- **Purchase idempotency spine (durable, minimal, money-only):** *per `transaction_id`, we must be able to answer "seen before?"* — carrying `original_transaction_id` and a minimal ref. This is **uniqueness keys, not an event log** (FR-010) — permitted alongside the user spine. Enables durable, never-windowed money dedup (§F).
- **Raw local + currency retained separately** from `normalized_revenue` so re-normalization under a corrected FX table (for **unsealed** days) is possible without re-ingest, and so the normalized figure is always re-derivable from (raw amount, currency, purchase-date FX).
- **`transaction_id`-keyed context resolution:** *given a server revenue row, we must be able to produce its dimension-combo* by joining the client companion on `transaction_id`, falling back to server-derivable dims, then `unknown`. The companion holds no durable money and need not persist as an event — only its resolved dimension contribution to the rollup cell must be derivable.
- **Per-user spine reuse (minimal):** `first_seen` (already in the retention spine) supports server-side `days_since_install` / `install_cohort` without new per-user money history. **`sessions_before_purchase` is NOT derived server-side** — it arrives pre-computed on the companion (SESSIONS DECISION), so no per-user session history is kept. This keeps the money path results-only.
- **Computable WITHOUT raw re-scan?** **Yes.** Every measure is an incremental upsert into the rollup at process-time from (server row + joined companion + FX config + idempotency check). No historical raw scan is needed for any live figure. The **only** operation that would need raw is a *retroactive* dimension/bucket re-slice — which is exactly why dimension changes are **forward-only** (FR-020) and the raw file is a manual backfill floor, not a live dependency.

## 6. Edge Cases & Failure Modes

- **Duplicate / retried purchase (§F):** offline purchase retry can arrive **days** later — a Redis 24h window cannot catch it. Deduped **durably** by store `transaction_id` (Postgres UNIQUE, `ON CONFLICT DO NOTHING`). Money **never** double-counts. (Contrast: non-money generic/economy events use the 24h `event_id` window and tolerate rare beyond-window double-count; purchases do not.)
- **Missing client companion (§D-5):** revenue row **stands alone**; client-only dimensions (`in_game_state`, `sessions_before_purchase`) → `unknown`; server-derivable dims survive. Revenue is never blocked. The `unknown` slice is reported as first-class so context-coverage is visible.
- **Late companion vs. day seal (§G):** a companion arriving within the 48h grace can still enrich its (unsealed) cell. A companion for an **already-sealed** day's purchase is **quarantined to the raw file** — the sealed rollup is not mutated. Net effect: that purchase's revenue was already correctly counted at seal time; only its late-arriving context is deferred to a possible future backfill.
- **Companion with no server row (orphan):** client says a purchase happened but no server-verified row exists (spoof, unverified, or server row genuinely never came). **Zero revenue** — client is never money truth (§D). Orphan companions are inert; retained only briefly for a possibly-late server row, then discardable.
- **Sandbox / test purchases (§D-3):** `environment=sandbox` **excluded from revenue** at ingest classification; never enters any rollup cell.
- **Unverified server row:** `verified=false` does not count toward revenue (carried for audit, not rollup).
- **Typed-kind validation failure (§H):** a `purchase` row missing a required field is **quarantined to the raw file**, not counted — money correctness beats coverage. Reserved name `purchase` always routes to the strict path even if malformed (§H-2).
- **Clock skew / event-time (§G):** the purchase's UTC-day attribution uses skew-corrected time; future-dated → clamped to server-now; wild-skew → quarantine. The store `transaction_id` (not the clock) is the identity, so skew cannot cause a double-count or a lost purchase, only a possible day-boundary attribution shift within tolerance.
- **Redis loss (§E):** revenue truth lives in durable Postgres results + the `transaction_id` idempotency spine + the write-ahead raw file, none of which are Redis. Losing Redis loses at most ≤5 min of un-flushed rollup drift and today's live counters; the durable money spine and completed raw file survive, so no purchase is counted-but-unlogged.
- **FX table changed after data exists (§D-2):** sealed days keep their as-of-date normalized revenue (not re-normalized). Only unsealed days re-derive from raw local + currency + updated FX.

## 7. Open Questions

Pulled from research §6 (§D-1..5) plus new items this metric surfaces. Each has a default so `/plan` isn't blocked.

- **§D-1 Refunds / chargebacks [OPEN]:** subtract (net) or gross-only? Refunds arrive via App Store Server Notifications V2 / Play RTDN. *Default: gross-only in v1; carry `refunded` flag + a notification hook for v2 net revenue. Rollup revenue is gross; do not retro-subtract sealed days.*
- **§D-2 Currency normalization ownership [OPEN]:** who owns the FX table and its as-of date? *Default: store raw `price_local` + `currency` always; normalize via operator-supplied config FX table **stamped at purchase UTC date**; defer live FX. Sealed days are not re-normalized.*
- **§D-4 Identity ↔ store-transaction mapping [OPEN]:** Apple `appAccountToken` isn't guaranteed. *Default: game passes `user_id` to the server SDK at validation time; store it on the purchase row (needed for `payer_tier`, `days_since_install`).*
- **§D-3 / §D-5 [LEANING]:** sandbox excluded via `environment` field; missing companion → reduced-dimension revenue that still counts. Adopted above; confirm.
- **New — Companion retention / orphan TTL:** how long is an unmatched companion held for a possibly-late server row before discard, and vice-versa? *Default: hold within the 48h day-seal grace; after seal, unmatched companions quarantine, unmatched-server rows already counted. Aligns to §G.*
- **New — `sessions_before_purchase` trust & reset semantics:** it is a **client counter** (SESSIONS DECISION) — spoofable and reset-on-reinstall. *Default: accept as a low-trust dimension for slicing only (never money); document that it is client-authored and not server-verifiable; treat missing as `unknown`.*
- **New — `in_game_state` vocabulary:** free-form client string risks cardinality sprawl across games. *Default: accept-all but subject to the per-dimension-value cardinality guardrail (mirror §H-4's name-cap posture); operator may later constrain to an allowed set per game.*
- **New — Reduced-dimension `unknown` reporting:** should the dashboard surface "% of revenue with full context" so the operator knows how much sits in `unknown` buckets? *Default: yes — expose a context-coverage figure; it directly signals companion-delivery health.*
