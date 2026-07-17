# Phase 01 — Ingest + Raw Events / Catalog

**Feature**: 001-analytics-platform · **Story**: US1 (P1 foundation) · **Reserved kind owned**: `generic` · **Status**: Draft
**Depends on**: nothing — this is the foundation every other phase sits on.
**Deeper reference**: [`../metrics/01-raw-events-catalog.md`](../metrics/01-raw-events-catalog.md). **Spec**: US1, FR-001..004 (tenancy/identity), FR-005..008c (ingestion/schema).
**Excluded here** (→ later per-phase design): queue choice, worker layout, key layouts, DDL, wire format.

---

## 1. Story understanding

**The story.** A developer registers a game in the platform, gets an SDK key + a game-scoped ingest URL, drops the SDK into their Phaser/React game, fires events, and **watches the counts increment** within minutes — for their game, and only their game.

**The question it answers.** *"Is my game sending data, and what is it sending?"* This is the "counting up" first-run experience and the substrate every other metric rides on. Two coupled deliverables:
1. **The event catalog** — a self-populating, per-game registry of every event *name* seen, with its kind, first/last-seen, cumulative count, and the property keys observed on it. Derived metadata about the stream — never a raw event store.
2. **Live counts & top-N** — the current-UTC-day count per event name and the grand total, plus the top-N names by volume — the number that visibly ticks up as events arrive.

**What it means for the operator.** Confidence the integration works, a live pulse of volume, and a dashboard that fills itself in — no pre-declaring event schemas. Only the three reserved typed kinds (`economy` / `purchase` / `session`) are strictly validated; everything else is accepted permissively (**hybrid accept-all**, §H) so the operator can invent an event and see it appear the same minute.

**Trust boundary.** Client-sent generic events are the untrusted, spoofable majority — acceptable, because the catalog and raw counts make no money/economy claim. The server SDK may emit named events into the *same* catalog. Money/economy trust is a later phase's concern.

---

## 2. How it is calculated

**Time-bucketing.** UTC day, on skew-corrected client-event-time (shared foundation). Catalog `first_seen` / `last_seen` use the same corrected time.

**Grain.** Catalog = per `game_id` × `event_name`. Counts = per `game_id` × `event_name` × UTC-day (and a per-`game_id` × UTC-day grand total). **No user grain** — the catalog is stream-level and touches no per-user spine.

**Catalog upsert** (per accepted generic event, name `e`, game `g`):
- `first_seen(g,e) = min(existing, corrected_time)`; `last_seen(g,e) = max(existing, corrected_time)`.
- `count(g,e) += 1` **only if it survived dedup** (a repeat `event_id` within 24 h is a no-op). Count is **approximate-OK** (a duplicate beyond 24 h may double-count — accepted for non-money events).
- For each key `k` in `props`: add the observed value-type to the **type-set** `property_keys(g,e)[k]` (a *set*, not last-write-wins — mixed types raise a drift flag, never a rejection).
- If `e` is a new name and the game already holds `event_name_cap_per_game` names → **drop-and-count** into `dropped_capexceeded(g)`; do not register.

**Live count.** `live_count(g,e,day)` = accepted events named `e` whose corrected UTC day = `day`. Grand total = Σ over names.

**Top-N.** Rank names by `count` (all-time) or `live_count(…,today)` (live view); take `top_n_events`; ties broken by `last_seen` desc.

### Worked example

Game `g=42`, fresh integration. Cap 500, `top_n_events = 3`. Over one UTC day the collector accepts (post-dedup, post-skew):

| name | kind | count today |
|---|---|---|
| `level_start` | generic | 1 200 |
| `button_click` | generic | 3 050 |
| `screen_view` | generic | 900 |
| `economy` | economy | 400 |
| `session` | session | 260 |
| `boss_hit` | generic | 75 |

Plus 40 empty-`name` events, 12 unparseable bodies, 5 `economy` events missing `amount`.

- **Catalog**: 6 named rows. `level_start.property_keys = {level:{int}, mode:{str}}`; a later `level_start` with `level:"12"` makes it `{int,str}` and raises a drift flag — the event still counts.
- **live_total(42, today)** = 1200+3050+900+400+260+75 = **5 885** accepted.
- **Top-3 by volume**: `button_click` (3050), `level_start` (1200), `screen_view` (900).
- **Dropped-and-counted**: nameless 40 + unparseable 12 → drop tally **52** (surfaced, excluded from every rollup).
- **Quarantined**: 5 malformed `economy` → written to the raw file's quarantine; they do **not** count in the `economy` row's 400 nor any economy rollup.
- Name-cap: 6 names ≪ 500 → `boss_hit` registers normally.

---

## 3. Data needed (input)

This story consumes the **canonical envelope as-is** — it adds no new required field. What it needs from every event:

| Field | Why this story needs it | Req/Opt |
|---|---|---|
| `game_id` | Tenant scope; every catalog row and counter is per-game (server-derived from SDK-key auth). | required |
| `name` | The registry key — a free-form string or a reserved-kind name. | required (non-empty) |
| `kind` | Routes accept-all (`generic`) vs strict (`economy`/`purchase`/`session`). Defaults to `generic` if absent but `name` present. | required |
| `props` | Free-form bag; its **keys + observed value-types** populate the catalog. Values themselves are *not* stored by the catalog. | optional |
| `event_id` | Per-event dedup key so a duplicate does not inflate the count. | required |
| `client_event_time` / `client_sent_time` | Feed skew-correction → decide which UTC day a count lands in. | required |
| `server_received_time` | Collector stamp; other half of the skew formula; fallback bucket for nameless-drop counters. | required |

Minimum viable input for this story: a **stable non-empty `name`** and a **parseable body**. Absent either → dropped-and-counted (§6 of the deeper sheet).

**Registration input (one-time, per game).** To register a game the operator supplies a name; the platform returns a unique **SDK key** and a game-scoped **ingest URL**. Every ingest request authenticates by SDK key; invalid/unknown keys are rejected with nothing recorded (FR-003).

---

## 4. Data stored for longer-run processing

Durable, derived-metadata only — never raw events:

- **Event catalog (per game × event name):** `kind`, `first_seen`, `last_seen`, cumulative `count` (approximate-OK), `property_keys` as key → **observed-type set**, and a `status` (reserved for future promotion; v1 sets every name `accepted`). One row per discovered name.
- **Count rollups (per game × name × UTC-day, and per game × UTC-day grand total):** accepted-event counts, enough to render live counts and top-N without touching raw events. Sealed days are final; today is provisional.
- **Exception tallies (per game):** running counts of `dropped_nameless`, `dropped_unparseable`, `dropped_capexceeded`, `quarantined_typed` — counters only, no payloads — kept both per-UTC-day and lifetime.
- **Distinct registered-name count (per game):** to enforce the 500-name cap.

**No per-user spine.** Deliberate — the catalog stores no `user_id`, sets no retention bit, keeps no per-user history. This is what keeps it results-only-cheap and honors SC-007.

Everything here is an **incremental upsert at ingest** (min/max for seen-times, +1 for counts, set-union for property types). The catalog *is* the accumulated result; it is never re-derived by scanning raw. Computable without raw re-scan? **Yes.**

---

## 5. Data-structure thinking — Redis & database

*Conceptual shapes only. Actual keys / DDL are a later-phase decision.*

**Redis (transient, hot, ≤ 1 day).**
- **The ingest queue** — batches land here fast and are drained by workers; this is the backpressure absorber that keeps the ingest endpoint quick (FR-006).
- **Today's live counters** — per game × name × today, and the grand total, as fast-incrementing hot counters. These are what tick up on the dashboard in real time. Transient by design; lost on a Redis crash (accepted).
- **The dedup window** — the set of `event_id`s seen in the last 24 h (each with a TTL), consulted before a count is applied.
- **Reserved for accepted-but-not-yet-flushed** catalog deltas awaiting the periodic flush.

**Database (durable, results-only).**
- **The catalog** — one durable row of derived metadata per game × name; the self-populating dashboard reads from here for history.
- **Count rollups** — durable per game × name × sealed-UTC-day counts + grand totals; the historical counts.
- **Exception tallies** — durable per-game counters for observability.
- **Game registry** — the tenant table: game, SDK key, config.

**The bridge.** Redis hot counters + catalog deltas **flush to the database on the periodic cadence** as an idempotent absolute-value upsert (a retried flush is a no-op). The dashboard reads *today* live from Redis and *history* durably from the database. Nothing raw is ever written to the database.

---

## 6. Configurations

| Knob | Default | Range / values | Forward / retro |
|---|---|---|---|
| `event_name_cap_per_game` | 500 | 1–10000 | **Forward-only** for new names. Already-registered names are never evicted by lowering it; names beyond the cap are dropped-and-counted from the moment it is hit. |
| `property_key_cap_per_event` | 50 | 1–1000 | **Forward-only.** Keys already observed on a name stay; new keys beyond the cap on that name are ignored (event still counts). |
| `top_n_events` | 10 | 1–100 | **Display-only, immediate** — a read-time ranking; mutates no stored aggregate. |
| `pii_prop_denylist` | `[]` | list of property-key names | **Forward-only** — denylisted keys are stripped at ingest; already-registered keys are not retro-scrubbed by a config change (Open: manual one-shot scrub tool, not an automatic side-effect). |
| `pii_prop_hash` | off | off / hash-listed-keys | **Forward-only**, same rationale. |
| `drop_counter_visible` | on | on / off | **Display-only** — whether the dashboard surfaces the dropped/quarantined tallies. |

**Inherited globals (referenced, not redefined here):** dedup window 24 h (§F), day-seal grace 48 h (§G), flush cadence 5 min (§E), per-game reporting timezone offset (display-only). Rationale for the forward-only defaults: caps and denylists gate *ingestion*, and sealed aggregates / already-flushed catalog rows are immutable — a config change that reached backward would demand a forbidden raw re-scan.

---

## Cross-references

- Deeper sheet: [`../metrics/01-raw-events-catalog.md`](../metrics/01-raw-events-catalog.md) — full edge-case catalog (reserved-name collision, property-type drift, cardinality explosion, PII), rejected variants, open questions.
- Feeds every later phase: the accept-all substrate (this phase) is what economy/retention/monetization/sessions validate their reserved kinds *within*.
