# Phase 05 — Segmented Monetization

**Feature**: 001-analytics-platform · **Story**: US4 (P2) · **Reserved kind owned**: `purchase` · **Status**: Draft
**Depends on**: Phase 01 (ingest). Consumes Phase 02 (`sessions_before_purchase` is a client-SDK counter). Shares the server-SDK trust path with Phase 03.
**Deeper reference**: [`../metrics/04-segmented-monetization.md`](../metrics/04-segmented-monetization.md). **Spec**: US4, FR-018/019/020/021.
**Excluded here** (→ later per-phase design): key layouts, DDL, join implementation.

---

## 1. Story understanding

**The story.** The developer sees not just which package sold most, but which package sold most **to whom / when / in what game-context** — sliced by configurable dimensions (level bucket, region, in-game state, payer tier, days-since-install, sessions-before-purchase) — using **server-verified** purchase data.

**The question it answers.** *"Which package sold most to whom, when, and in what context?"* e.g. "players out of energy at level 12 in region X buy the Energy Refill pack." Segmentation is the differentiator over a plain revenue bar chart.

**Definition (server-truth + client-context join):** per game, over a UTC day, maintain a rollup keyed by **(product × dimension-combo)** producing **purchase count** and **normalized revenue**. Revenue comes **only** from server-verified purchase rows; the dimension values that segment it come from a **client context-companion event keyed by `transaction_id`**, joined onto the server row. "Top package by `<D>`" = rank products by summed measure within each value of `D`.

- **Money truth = server row.** The server SDK emits the authoritative revenue row (verified receipt). The client SDK emits a **zero-money companion keyed by the same `transaction_id`**, carrying purchase-time player context. Joined on `transaction_id`.
- **Companion is enrichment, never a gate.** If it never arrives, the server row **stands alone with reduced dimensions** (server-derivable dims survive; client-only dims render `unknown`). Revenue is never blocked on context.
- **Rejected variants:** client-reported revenue (spoofable — client contributes **zero** money); denormalize all context onto the server call (forces re-plumbing every field); reconcile-by-`transaction_id` money merge (deferred — v1 carries `source`/`verified`/`original_transaction_id` so it's a clean later upgrade).

**What it means for the operator.** Actionable "who buys what, and in what moment" — with a first-class `unknown` slice showing how much revenue lacks context (companion-delivery health).

---

## 2. How it is calculated

**Bucketing.** UTC day of the server row's skew-corrected event-time. Segment grain = **(product × active-dimension-combo)** per UTC day.

**Measures per cell (per game / product / dimension-combo / UTC day):**
- `purchase_count` = distinct **server-verified prod** purchases (deduped by `transaction_id`).
- `normalized_revenue` = Σ `price_local × fx_rate(currency, purchase_UTC_date)`.

**Eligibility (a purchase counts iff):** `source=server` AND `verified=true` AND `environment=prod` AND not already-seen `transaction_id`. `refunded=true` rows still count in **gross** v1.

**Dimension resolution:** join server row ← companion on `transaction_id`. Per active dimension: companion value if present; else the server-derivable value (`payer_tier`, `install_cohort`); else `unknown`. **`days_since_install` is server-wins** (derivable from `first_seen`, more trustworthy). `sessions_before_purchase` and `in_game_state` are **client-only** → `unknown` when the companion is missing.

**Top package by `<D>`:** for a chosen dimension `D` and period, for each value `v`, `top_product(D=v) = argmax_product Σ measure` over cells matching `(product, D=v)`, marginalizing the others.

### Worked example

Config: dimensions `[region, in_game_state]`, normalize to USD; FX stamped at purchase date: USD→1.00, EUR→1.10.

Server rows (all verified/prod unless noted), companions as noted:

| # | txn | product | price | curr | region | in_game_state | note |
|---|---|---|---|---|---|---|---|
| 1 | T1 | energy_pack | 0.99 | USD | EU | out_of_energy | |
| 2 | T2 | energy_pack | 0.90 | EUR | EU | out_of_energy | |
| 3 | T3 | gem_bundle | 4.99 | USD | EU | pre_boss | |
| 4 | T4 | energy_pack | 0.99 | USD | NA | out_of_energy | |
| 5 | T5 | starter_pack | 2.99 | USD | NA | post_defeat | |
| 6 | T6 | gem_bundle | 4.99 | USD | NA | pre_boss | |
| 7 | T7 | energy_pack | 0.99 | USD | — | — | **companion MISSING** |
| 8 | T4 | energy_pack | 0.99 | USD | NA | out_of_energy | **duplicate of T4** |
| 9 | T9 | gem_bundle | 4.99 | USD | EU | pre_boss | `environment=sandbox` |
| 10 | T10 | gem_bundle | 4.99 | USD | EU | pre_boss | `source=client`, **no server row** |

**Filter:** Row 8 (dup T4) → durable `transaction_id` dedup, **dropped**. Row 9 (sandbox) → **excluded**. Row 10 (client, no server row) → **zero money, inert**. Row 7 → **stands alone**, `region=unknown`, `in_game_state=unknown`.
Normalized USD: T1 0.99, T2 0.90×1.10=**0.99**, T3 4.99, T4 0.99, T5 2.99, T6 4.99, T7 0.99.

**Top package by `region`** (rank by revenue): EU → gem_bundle 4.99 (> energy 1.98); NA → gem_bundle 4.99; unknown → energy_pack 0.99 (the reduced-dimension bucket, T7).
**Top package by `in_game_state`:** out_of_energy → energy_pack 2.97; pre_boss → gem_bundle 9.98; post_defeat → starter_pack 2.99; unknown → energy_pack 0.99.

T7's **revenue is fully counted**; only its client-only dimensions degrade to `unknown` — reported as a first-class slice. Today is provisional (a late companion can enrich up to seal); sealed days are immutable.

---

## 3. Data needed (input)

Two sides; the trust boundary is the `source` field.

**Server SDK — authoritative revenue row** (`kind = purchase`, `source = server`; strictly validated — a missing required field → quarantine):

| Field | Meaning | Req? |
|---|---|---|
| `transaction_id` | Store-issued unique id. Dedup + join key. | required |
| `original_transaction_id` | Stable id across renewal/restore. | required |
| `product_id`, `product_category` | The SKU and its coarse category. | required |
| `price_local`, `currency` | Raw charged amount + ISO currency, **stored separately** from any normalized value. | required |
| `source` | `client`/`server`; here `server` — only `server` contributes revenue. | required |
| `verified` | Receipt validation succeeded; only `true` counts. | required |
| `environment` | `prod`/`sandbox`; **sandbox excluded from revenue**. | required |
| `user_id` | Game id passed to the server SDK (identity↔store mapping). | required |
| `refunded` | Gross-only v1 flag; hook for v2 net. | optional |
| server-derivable dims | `days_since_install`, `payer_tier`, `install_cohort` — survive even with no companion. | optional |

**Client SDK — context-companion** (keyed by `transaction_id`, **zero money**): `transaction_id` (join key, required) + optional `level_bucket`, `region`, `in_game_state`, `sessions_before_purchase` (**a client-SDK counter**, not server-derived), `days_since_install` (server wins if both present). Companions never dedup money, never create a cell alone, and are dropped from revenue math.

The normalized figure is computed downstream from a config FX table — **never sent by the SDK**.

---

## 4. Data stored for longer-run processing

- **Monetization rollup (result):** per game × product × active-dimension-combo × UTC-day — `purchase_count` and `normalized_revenue`. "Top package by `<D>`" is a marginalize-and-rank read. Grain includes an explicit `unknown` value per dimension for reduced-dimension purchases.
- **Purchase idempotency spine (durable, minimal, money-only):** per `transaction_id` — "seen before?", carrying `original_transaction_id` + a minimal ref. **Uniqueness keys, not an event log** (permitted alongside the user spine). Enables durable, never-windowed money dedup.
- **Raw local + currency retained separately** from `normalized_revenue`, so an unsealed day can re-normalize under a corrected FX table without re-ingest, and the normalized figure is always re-derivable.
- **Per-user spine reuse (minimal):** `first_seen` (from Phase 04) supports server-side `days_since_install` / `install_cohort`. **`sessions_before_purchase` is NOT derived server-side** — it arrives pre-computed on the companion, so no per-user session history is kept.

Computable without raw re-scan? **Yes** — every measure is an incremental upsert from (server row + joined companion + FX config + idempotency check). The **only** thing needing raw is a *retroactive* dimension re-slice — exactly why dimension changes are forward-only.

---

## 5. Data-structure thinking — Redis & database

*Conceptual shapes only.*

**Redis (transient, hot).**
- **Today's rollup accumulators** — per game × product × dimension-combo × today: running count + normalized revenue. Hot; lost on crash (accepted; money truth is not here).
- **Companion staging** — client companions held briefly awaiting a possibly-late server row (and vice-versa), within the 48 h grace, for the `transaction_id` join.
- (Money dedup is **not** a Redis window — see below.)

**Database (durable, results-only).**
- **Monetization rollup** — durable per game × product × dimension-combo × sealed-day count + revenue. The dashboard reads and marginalizes this.
- **Purchase idempotency table** — the durable `transaction_id` UNIQUE spine; the **authoritative money dedup** (`ON CONFLICT DO NOTHING`), outliving any transient window. This is why an offline purchase retry arriving *days* later never double-counts.
- **Raw local + currency** kept beside normalized revenue for unsealed re-normalization.

**The bridge.** Hot rollup accumulators flush to durable results on the cadence (idempotent absolute upsert). But the **money-correctness guarantee lives in the durable `transaction_id` spine, not Redis** — the sharp contrast with non-money events (which tolerate a 24 h window and rare beyond-window double-count). Revenue truth (durable results + idempotency spine + write-ahead raw file) is never in Redis, so a Redis loss never counts-but-unlogs a purchase.

---

## 6. Configurations

| Knob | Default | Range / values | Forward / retro |
|---|---|---|---|
| `monetization_dimensions` | `[level_bucket, region, in_game_state, payer_tier]` | subset of `level_bucket`, `region`, `in_game_state`, `payer_tier`, `days_since_install`, `sessions_before_purchase` | **Forward-only (rebuild-forward).** Changing the set re-keys rollup cells; sealed rollups keep their old keys. Re-slicing history needs a forbidden raw re-scan. |
| `level_bucket_boundaries` | operator-set (e.g. `[1,5,10,20,50]`) | ascending cut points | **Forward-only** — re-bucketing history would rewrite sealed cells. |
| `fx_table` | operator-supplied, **stamped at purchase date** | per-currency dated rate | **Forward-only for sealed days** — a day's normalized revenue uses the as-of-date rate; sealed days are not re-normalized when the table later changes. |
| `normalization_currency` | operator-set (e.g. `USD`) | single target currency | Forward-only for sealed days (paired with `fx_table`). |
| `sandbox_excluded` | `true` | bool | Applies at ingest classification; `environment=sandbox` never enters revenue. |
| `payer_tier_rule` | first / repeat / whale by cumulative spend | operator thresholds | Forward-only if it changes how a purchase is tiered at count-time. |

**Inherited globals:** dedup posture (§F), day-seal 48 h, flush 5 min.

---

## Cross-references

- Deeper sheet: [`../metrics/04-segmented-monetization.md`](../metrics/04-segmented-monetization.md) — companion orphan TTL, refunds/net-revenue (§D-1), FX ownership (§D-2), identity↔store mapping (§D-4), `in_game_state` vocabulary, context-coverage reporting, all open questions.
- Feeds **Phase 06** (revenue rollup + payer set are the numerators for ARPU/ARPPU/ARPDAU/whale). Consumes **Phase 02** (`sessions_before_purchase`) and **Phase 04** (`first_seen` for server-derivable dims).
