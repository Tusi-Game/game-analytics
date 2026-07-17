# Phases — Per-Story Design Specs

**Feature**: 001-analytics-platform · **Layer**: story design (sits between `../spec.md` and `../metrics/`) · **Status**: Draft (2026-07-17)

This directory breaks the system into **one spec per story**. Each phase-spec is a *conceptual design of one story* — what it is, how it is calculated, what data it needs, what it stores for the long run, how that data is shaped in Redis vs the database (at the design-thinking level), and every configuration knob the operator gets.

**Deliberately excluded from these specs:** technical difficulty, system-design / infrastructure sequencing, table DDL, Redis key layouts, worker pseudocode, wire formats, deploy topology. Those belong to the later **per-phase design + implementation** step. A phase-spec answers *what the story is and what it needs*; it does not answer *how hard it is to build or in what order*.

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

**Reading order:** 01 (foundation) → 02 (sessions — the activeness anchor everything else leans on) → 03 / 04 / 05 (the core metrics) → 06 (derived from all of the above) → 07 (operational lifecycle, read anytime after 01).

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

Funnels remain **design-only / deferred** for v1 (FR-022). They get **no phase-spec** here. The forward-compatible funnel data-model note in `../spec.md` stands; the deeper (deferred) funnel design lives in [`../metrics/06-funnels.md`](../metrics/06-funnels.md), which still carries the unratified scope-promotion flag. Ratifying funnels later would add an 08 phase-spec; until then there are seven.
