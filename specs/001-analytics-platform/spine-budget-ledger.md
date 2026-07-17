# Per-user / per-payer spine-budget ledger — reconciles against SC-007

**Part of:** [001-analytics-platform](spec.md) · **Authority:** this ledger — not any single story-spec's self-assessment — is the source of truth on total per-user durable cost. Cited by [bridge 05.5](bridges/05.5-purchase-accept-contract.md) and [`ops-envelope.md`](ops-envelope.md).

SC-007 requires Postgres to hold only results + a **minimal per-user spine** (a handful of small columns). Several stories must add durable per-user or per-payer state. This is the single consolidated accounting — no story is "the only" spine expansion; here is every draw:

| Source story | Durable per-user/per-payer state | Keyed per | Size posture | Status |
|---|---|---|---|---|
| [005 Retention](../005-retention/spec.md) | `first_seen` + active-days bitmap | **user** | ~4–46 bytes/user (locked in research §B) | **Core spine** (baseline, already in spec) |
| [007 Derived KPIs](../007-derived-kpis/spec.md) | first-purchase-day flag (write-once) | **payer** | 1 small field, payer-bounded | Minimal; needed for first-purchase conversion |
| [007 Derived KPIs](../007-derived-kpis/spec.md) | per-payer cumulative period spend | **payer** | payer-bounded (payers ≪ users), per period | Modest; needed for whale concentration (WC-1: full vs top-k) |
| [006 Monetization](../006-monetization/spec.md) (bridge 05.5) | per-payer **lifetime** cumulative normalized spend (`lifetime_spend_normalized`) | **payer** | 1 small numeric, payer-bounded (payers ≪ users) | **Ratified 2026-07-17 (Q3)** — needed for payer-tier classification (whale by lifetime spend); row-existence = payer/non-payer boundary, non-payers cost zero; rebuildable from `PURCHASE_IDEMPOTENCY` + dated FX |
| [004 Economy](../004-economy/spec.md) | last-known balance per user × currency (optional) | **user × currency** | only if `economy_depth_capture_mode` on | Optional; off ⇒ no cost |
| Funnels ([`funnels.md`](funnels.md)) | (none in v1) — per-participant progress record is deferred with funnels | — | 0 bytes/user in v1; largest draw deferred to v2 | **DECLINED for v1 (2026-07-17)** — zero cost; per-participant progress deferred with funnels |

**Not a spine draw (operational, recorded here to head off confusion):** `ERASURE_LEDGER` (GDPR/CCPA erasure requests — Q7, normative in [`ops-envelope.md`](ops-envelope.md)) keys per *erasure request*, not per user, and stores the subject as a per-game keyed hash — never a plaintext `user_id`. It costs nothing against the per-user budget and expires once `raw_retention_days` passes every file the subject could appear in. Likewise the [011 operator-admin](../011-operator-admin/spec.md) credential/audit entities are per-game/per-operator, not per-player.

**Reconciliation:** the payer-bounded draws (007 + the 2026-07-17 lifetime-spend line) are small at indie scale (payers are a few % of users; each is one small numeric per payer). The economy draw (004) is opt-in with default `off`. Funnels carries **zero** v1 spine cost (deferred). Baseline retention + these controlled additions keep the spine within the SC-007 intent, but this ledger is the authority on total per-user cost. Confirm final sizing at `/plan`.

## Funnels scope decision — DECLINED (resolved 2026-07-17)

**Funnels are deferred beyond v1 (design-only).** The contradiction between the funnel design and FR-022 has been resolved by declining the scope promotion. FR-022 stands: v1 designs the data model for one funnel per game but ships no funnel ingestion, computation, or UI. [`funnels.md`](funnels.md) remains as a forward-compatible specification artifact — the calculation, config model, and data-shape requirements are correct and ready for v2. The per-participant progress spine is not carried in v1's spine ledger.
