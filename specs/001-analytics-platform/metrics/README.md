# Per-Metric Spec Sheets — Index

**Feature**: 001-analytics-platform · **Phase**: research/specify · **Status**: Draft (2026-07-17)

These sheets sit **below** [`../spec.md`](../spec.md) (the requirement) and [`../research.md`](../research.md) (the adopt-vs-build survey, domain knowledge §A–§D, and the locked §B–§H decisions). Each sheet takes one metric and pins down the triplet the operator's brief asked for:

1. **What SDK data we capture** for that metric (conforming to the one canonical event envelope — never redefining it).
2. **What admin configuration** the operator gets — each knob with its default and whether a change applies **forward-only** or **retroactively**.
3. **How it is calculated** — precise definition, formula, worked numeric example, and the **data-shape requirements** (what must be *derivable*), stated at **research altitude**.

**Phase discipline (deliberate):** these are research-phase artifacts. They contain formulas, worked examples, and data-shape requirements — but **no** table DDL, column types, Redis key layouts, worker pseudocode, or wire formats. Those are `/plan` concerns and are intentionally left open. A formula is research; a schema is planning.

## The sheets

| # | Sheet | Metric | Reserved kind(s) it owns |
|---|---|---|---|
| 01 | [Raw & Custom Events (Event Catalog)](01-raw-events-catalog.md) | Accept-all named events, live counts, top-N, the self-populating per-game catalog | `generic` (substrate for all) |
| 02 | [Economy (Sink / Source)](02-economy-sink-source.md) | Faucets vs drains, net flow, sink ratio, per-reason breakdown, currency depth | `economy` |
| 03 | [Retention (Classic Day-N)](03-retention.md) | D1/D7/D30 + the cohort heatmap triangle, classic Nth-day | (consumes `session`) |
| 04 | [Segmented Monetization](04-segmented-monetization.md) | Top package by dimension, server-truth revenue + client context companion | `purchase` |
| 05 | [Sessions](05-sessions.md) | Session definition (§X-2 resolution), count, duration, sessions/user, frequency | `session` |
| 06 | [Funnels](06-funnels.md) | Ordered steps, conversion window, drop-off, time-to-convert ⚠️ **scope flag** | (consumes any) |
| 07 | [Derived KPIs](07-derived-kpis.md) | DAU/WAU/MAU, stickiness, ARPU/ARPPU/ARPDAU, conversion, whale concentration | (derived from others) |

**Reading order:** 01 (foundation) → 05 (sessions — the shared activeness anchor) → 03/02/04 (the core metrics) → 07 (derived from all of the above) → 06 (funnels — read last; carries an unresolved scope decision).

## Shared foundations every sheet obeys

- **One canonical event envelope**: `game_id`, `user_id` (+ `anon_id`), `session_id`, `event_id`, `name`, `kind` ∈ {generic, economy, purchase, session}, `client_event_time`, `client_sent_time`, `server_received_time`, `props`. No sheet invents or renames these.
- **Skew-corrected event-time** (§G): `corrected = client_event_time + (server_received_time − client_sent_time)`; bucketed as **UTC day**; 60s dead-band; future-clamp; **48h day-seal grace** then quarantine-to-raw. Quoted identically across sheets.
- **Activeness** (locked §B-1): a user is "active" on a UTC day iff a `session` event **started** that day. Retention (03), sessions (05), and DAU (07) all use this one definition.
- **Money truth = server** (§D): revenue is server-verified only; the client emits a zero-money context companion keyed by `transaction_id`. Non-money events dedup by `event_id` + 24h; **money dedups durably by `transaction_id`**, never a time window.
- **Results-only storage** (FR-010 / SC-007): every metric is computable from incremental results + a minimal per-user spine, without re-scanning raw events. Where a metric must expand the spine, it is reconciled in the ledger below.

## ⚠️ Open scope decision (must ratify before `/plan`)

**Funnels promotion (sheet 06 §7 OQ-1).** The current spec locks funnels as **design-only / deferred** (FR-022; Clarifications 2026-07-17, "Funnels are deferred"). Sheet 06 **fully specs funnels as a computed v1 metric** at the operator's explicit request — which **contradicts that lock** and adds a per-user progress spine (see ledger). This is a genuine scope change the operator must ratify:
- **Ratify** → amend FR-022 and the Clarifications lock in `spec.md`, accept the bounded per-participant spine cost (prune progress rows once cohorts seal).
- **Decline** → sheet 06 reverts to design-only; the calculation/config stays as a forward-compatible design, uncomputed in v1.

Sheet 06 does **not** silently override the spec — it flags the conflict and asks. Until ratified, the sheet-set intentionally carries this one open contradiction against the spec's funnel lock.

## Per-user / per-payer spine-budget ledger (reconciles against SC-007)

SC-007 requires Postgres to hold only results + a **minimal per-user spine** (a handful of small columns). Several metrics must add durable per-user or per-payer state. This is the single consolidated accounting — no sheet is "the only" spine expansion; here is every draw:

| Source sheet | Durable per-user/per-payer state | Keyed per | Size posture | Status |
|---|---|---|---|---|
| 03 Retention | `first_seen` + active-days bitmap | **user** | ~4–46 bytes/user (locked in research §B) | **Core spine** (baseline, already in spec) |
| 07 Derived KPIs | first-purchase-day flag (write-once) | **payer** | 1 small field, payer-bounded | Minimal; needed for first-purchase conversion |
| 07 Derived KPIs | per-payer cumulative period spend | **payer** | payer-bounded (payers ≪ users), per period | Modest; needed for whale concentration (WC-1: full vs top-k) |
| 02 Economy | last-known balance per user × currency (optional) | **user × currency** | only if `economy_depth_capture_mode` on | Optional; off ⇒ no cost |
| 06 Funnels | per-participant progress record (furthest step + entry time) | **funnel participant** | largest draw; **prunable** once cohort seals | **Conditional on funnels ratification** (see above) |

**Reconciliation:** the payer-bounded draws (07) are small at indie scale (payers are a few % of users). The economy draw (02) is opt-in. The funnels draw (06) is the largest and is *conditional* on the scope decision — and even then is prunable to just the sealed histogram. Baseline retention + these controlled additions keep the spine within the SC-007 intent, but this ledger — not any single sheet's self-assessment — is the authority on total per-user cost. Confirm final sizing at `/plan`.

## What these sheets feed

Once the funnels scope is ratified (or declined) and the highest-leverage open questions are settled, these sheets are the **input to `/plan`**: each sheet's §4 (calculation) and §5 (data-shape requirements) tell the `/plan` author exactly what to design storage and workers for, while leaving the storage/key/worker choices open. The open questions across all seven sheets (§7 of each) extend `research.md §6` with metric-specific second-order items, each carrying a default recommendation so `/plan` is never blocked.
