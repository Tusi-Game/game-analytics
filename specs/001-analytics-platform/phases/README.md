# Phases — Per-Story Design Specs

**Feature**: 001-analytics-platform · **Layer**: story design (sits between `../spec.md` and `../metrics/`) · **Status**: **Design-complete (2026-07-17)**

This directory breaks the system into **one spec per story**. Each phase-spec is a *conceptual design of one story* — what it is, how it is calculated, what data it needs, what it stores for the long run, how that data is shaped in Redis vs the database (at the design-thinking level), and every configuration knob the operator gets.

**Deliberately excluded from these specs:** technical difficulty, system-design / infrastructure sequencing, table DDL, Redis key layouts, worker pseudocode, wire formats, deploy topology. Those belong to the later **per-phase design + implementation** step. A phase-spec answers *what the story is and what it needs*; it does not answer *how hard it is to build or in what order*. *(That exclusion applies to the §1–6 story content. The **design layer** below has since landed — logical model, key patterns, op-ordering — while DDL, code, and deploy topology remain excluded.)*

## The fixed 6-part structure

Every phase-spec follows the same skeleton, so any two are comparable:

1. **Story understanding** — what the story is, the question it answers, what it means for the operator.
2. **How it is calculated** — the definition, the formula, a worked numeric example.
3. **Data needed (input)** — what the SDK / events must supply for this story.
4. **Data stored for longer-run processing** — the durable spine / rollups this story keeps so raw events never have to be reprocessed.
5. **Data-structure thinking — Redis & database** — the *conceptual shape* of the data in each store (what is a hot transient counter in Redis, what is a durable result/rollup/spine in the database), at design altitude. **No** keys, DDL, or column types.
6. **Configurations** — every operator knob for this story, its default, and whether a change applies **forward-only** or **retroactively**.

## The phases

| # | Phase spec | Story | Reserved kind it owns | Depends on |
|---|---|---|---|---|
| 01 | [Ingest + Raw Events / Catalog](01-ingest-raw-events.md) | Register a game, fire events, watch them count up (US1) | `generic` (substrate for all) | — (foundation) |
| 02 | [Sessions](02-sessions.md) | The atomic unit of engagement; the shared "active on a day" anchor | `session` | 01 |
| 03 | [Economy (Sink / Source)](03-economy.md) | Faucets vs drains, net flow, sink ratio, currency depth (US2) | `economy` | 01 |
| 04 | [Retention (Classic Day-N)](04-retention.md) | D1/D7/D30 by install cohort (US3) | consumes `session` | 01, 02 |
| 05 | [Segmented Monetization](05-monetization.md) | Top package by whom / when / context; server-truth revenue (US4) | `purchase` | 01 |
| 06 | [Derived KPIs](06-derived-kpis.md) | DAU/WAU/MAU, stickiness, ARPU/ARPPU/ARPDAU, conversion, whale | derived (no own kind) | 02, 05 |
| 07 | [Cold-Storage Lifecycle](07-cold-storage.md) | Daily raw file → S3-compatible → delete local (US5) | — (ops) | 01 |
| 08 | [Client SDK](08-client-sdk.md) | The browser/game SDK — the packaged client artifact (npm) | emits all kinds (client-provenance) | 01, 02, 03, 05 |
| 09 | [Server SDK](09-server-sdk.md) | The Node server SDK — the trusted money/economy path (npm) | emits `purchase`/`economy` (server-provenance) | 05, 03; Foundation §4.5 |
| 10 | [Operator / Admin](10-operator-admin.md) | Operator auth, game registration + key rotation, config admin | — (control plane) | 01, Foundation §4.5 |

Plus one operational envelope spec sitting beside the foundation: [`00.5-ops-envelope.md`](00.5-ops-envelope.md) — scale/memory/backpressure numbers, per-game rate limiting, scale-lever triggers, and the GDPR/CCPA data-erasure design (Q7).

**Design status:** every phase 01–07 above is **design-complete** — each carries a `## Design` section (its logical-model realization on the shared foundation) below its untouched §1–6 story content. See the design layer below.

**Reading order:** 01 (foundation) → 02 (sessions — the activeness anchor everything else leans on) → 03 / 04 / 05 (the core metrics) → 06 (derived from all of the above) → 07 (operational lifecycle, read anytime after 01). For the design layer: `00-foundation.md` first, then each phase's `## Design`, then the bridges, then `ER-full.md`.

## The design layer (design-complete, 2026-07-17)

Each phase now carries a **`## Design` section** appended below its §1–6 story content — additions only, on one shared base, at logical-model altitude (entities/keys/cardinality, Redis patterns/types/TTLs, worker op-ordering additions, contract shapes — no DDL, no code). The layer's artifacts:

| Design artifact | Purpose (one line) |
|---|---|
| [`00-foundation.md`](00-foundation.md) | The shared design base: global ER skeleton + spine tiers, Redis key grammar/TTLs, pipeline backbone + canonical op-ordering (incl. the routed record), dedup/skew/seal machinery, provenance, ownership matrix, durability ledger. Every `## Design` cites it, never re-derives it. |
| `## Design` in [`01`](01-ingest-raw-events.md) … [`07`](07-cold-storage.md) | Per-story realizations — what each story owns and adds on the backbone; the **per-entity source of truth** where they refine the foundation skeleton. |
| [`01.5-raw-file-contract.md`](01.5-raw-file-contract.md) | **Bridge 01 ↔ 07** — the write-ahead raw day-file contract: open-file routing, quarantine-marker vocabulary, batch-fsync grain, rotation, cold-off behavior, sealed-file upload eligibility, the SC-008 superset statement. |
| [`02.5-activeness-spine-contract.md`](02.5-activeness-spine-contract.md) | **Bridge 01 · 02 → 04** — the spine write-delegation contract: sequences A (first-touch seed) and B (session-start bit) with identical transition/crash semantics, negative-offset / over-horizon / sealed-day rules; home of the `first_seen` ruling. |
| [`05.5-purchase-accept-contract.md`](05.5-purchase-accept-contract.md) | **Bridge 05 ↔ 06** — the money seam: gate-coupled atomic unit (exactly-once application), signal payload, `payer_tier` read-before-write ordering; carries the payer-tier cumulative-spend question. |
| [`ER-full.md`](ER-full.md) | The assembled whole-system ER — every durable entity with keys, the ownership/write-path legend, and the projections-vs-truth map. |
| `## Design` in [`08`](08-client-sdk.md) / [`09`](09-server-sdk.md) | The two packaged-artifact stories — SDK behavior contracts + the npm monorepo packaging/publishing design (workspace layout, scoped names, build targets, changesets, OIDC trusted-publish + provenance, MIT SDKs / Apache-2.0 platform per Q10). |
| [`10-operator-admin.md`](10-operator-admin.md) | The operator control plane — accounts, game registration + credential (Q2) lifecycle, the admin surface over every §6 knob, the forward-only config-effective-time rule, `OPERATOR_ACCOUNT`/`CONFIG_AUDIT`/credential-child entities. |
| [`00.5-ops-envelope.md`](00.5-ops-envelope.md) | The ops envelope — scale arithmetic, Redis/queue budgets, backpressure posture, per-game rate limiting, scale-lever trigger points, and the normative GDPR/CCPA erasure design + `ERASURE_LEDGER` (Q7). |

Two further flagged bridges were **folded into the foundation** instead of filed: the typed-kind handoff contract (Foundation §3.1, "the routed record") and the server-credential trust path (Foundation §4.5, provenance).

### Operator-ratification questions — **all resolved 2026-07-17** (research-ratified in the SDK + hardening phase)

Every item below carries a locked decision record + rationale + named sources in its home document; the full research trail is [`../research.md` §7](../research.md). Nothing here remains open.

1. **`first_seen` determination** — ✅ **RESOLVED**: first accepted **session** event (not any-event); sequence A relocates to 02's session path. D0 = 100 % invariant; never-sessioned users have no spine row; money family spine-independent. Home [bridge 02.5 §6](02.5-activeness-spine-contract.md); Foundation §5/§9.4/§3.1 + 02/04 Designs updated. *(Q1)*
2. **Provenance / F-3 key-class** — ✅ **RESOLVED**: two credential classes — public `sdk_key` / secret `server_credential` (Stripe-archetype split), prefix-typed, plain-bearer (no HMAC v1), dual-active rotation. Home [Foundation §4.5](00-foundation.md) (F-3 closed) + §9.5; issuance/rotation → [phase 10](10-operator-admin.md). *(Q2)*
3. **Payer-tier cumulative-spend** — ✅ **RESOLVED**: **lifetime** `lifetime_spend_normalized` on `PAYER_SPINE_EXT`, fixed thresholds; spine-ledger amended. Home [bridge 05.5 §6](05.5-purchase-accept-contract.md); Foundation §1.2 + `../metrics/README.md` ledger updated. *(Q3)*
4. **Upload eligibility = sealed file vs US5/SC-010 "yesterday"** — ✅ **RESOLVED**: ship-at-seal (Kafka-Connect close-then-ship, GA4 ~72 h daily-export finality, S3 object immutability). Home [bridge 01.5 §6](01.5-raw-file-contract.md); 07 Design updated. *(Q4)*
5. **`ECONOMY_SUPPLY_DAY` projection** — ✅ **RESOLVED**: ratified as a daily *balance* snapshot at seal (not materialized cumulative flow, which stays a query-time window function); gated on depth mode. Home 03 Design; Foundation §5 + ER-full. *(Q5)*
6. **Monetization residual display drift** — ✅ **RESOLVED**: accept-with-reconciliation, promoted to normative (reconciliation now a required job gating seal; outbox + PG-live-views rejected with precedent). Home 05 Design. *(Q6)*

Four net-new hardening questions resolved alongside: **Q7** data-erasure (four-tier GDPR/CCPA posture → [`00.5-ops-envelope.md`](00.5-ops-envelope.md)), **Q8** missing-FX-rate (as-of lookup + park-unconverted → 05 Design; `fx_staleness_max_days` knob), **Q9** envelope wire versioning (`/v1/events` + batch `v` + additive-only-forever → [Foundation §1.1/§9.7](00-foundation.md)), **Q10** license + npm (Apache-2.0 platform / MIT SDKs; trusted publishing + provenance + changesets → SDK specs 08/09).

## Relationship to `../metrics/` sheets

These phase-specs are a **new per-story layer**. The deeper per-metric reference in [`../metrics/`](../metrics/README.md) is kept and cross-linked from each phase — the metric sheets carry the fuller edge-case catalogs, rejected-variant rationale, and open-question trails. Where a phase-spec and its metric sheet overlap, they agree by construction (the phase-spec is a re-projection of the sheet into the 6-part structure); the metric sheet remains the deeper reference, the phase-spec the story-level design.

## Shared foundations every phase obeys

Stated once here; no phase re-defines them.

- **One canonical event envelope**: `game_id`, `user_id` (+ `anon_id`), `session_id`, `event_id`, `name`, `kind` ∈ {`generic`, `economy`, `purchase`, `session`}, `client_event_time`, `client_sent_time`, `server_received_time`, `props`.
- **Skew-corrected event-time** (§G): `corrected = client_event_time + (server_received_time − client_sent_time)`; bucketed as **UTC day**; 60 s dead-band; future-dated clamps to server-now; a day stays mutable for a **48 h grace** then **seals** — later events for a sealed day are **quarantined to the raw file**, never folded in.
- **Activeness** (§B-1, locked in Phase 02): a user is "active" on a UTC day **iff a `session` event started that day**. Retention (04), sessions (02), and DAU (06) all use this one definition.
- **Money truth = server** (§D): revenue is **server-verified only**; the client emits a zero-money context companion keyed by `transaction_id`. Non-money events dedup by `event_id` + 24 h; **money dedups durably by `transaction_id`**, never a time window.
- **Results-only storage** (FR-010 / SC-007): the database holds only **processed results + a minimal per-user spine** — never raw event logs. Every metric is computable from incremental results without re-scanning raw events.
- **Write-ahead raw ordering** (§E): a worker appends the raw file (fsync'd, if cold storage is on) **before** updating any counter — so the raw file is always a complete superset of anything counted (the manual rebuild floor; SC-008).

## Scope note — Funnels are NOT a phase

Funnels remain **design-only / deferred** for v1 (FR-022). They get **no phase-spec** here. The forward-compatible funnel data-model note in `../spec.md` stands; the deeper (deferred) funnel design lives in [`../metrics/06-funnels.md`](../metrics/06-funnels.md), which still carries the unratified scope-promotion flag. **Numbering note (updated 2026-07-17):** 08 was informally reserved for funnels, but the SDK + hardening phase claimed **08 (client SDK)** and **09 (server SDK)**; ratifying funnels later would add them at the **next free number (11)**, not 08. Until then the metric-story phases are seven (01–07), joined by the two SDK packaged-artifact stories (08/09), the operator control plane (10), and the ops envelope (00.5).
