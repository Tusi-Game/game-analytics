# Ingest + Raw Events / Catalog (US1)

**Part of:** [001-analytics-platform](../001-analytics-platform/spec.md)
**Story:** US1 (P1 foundation) · **Reserved kind owned:** `generic` · **Status:** Draft
**Depends on:** the shared platform substrate — [`../001-analytics-platform/foundation.md`](../001-analytics-platform/foundation.md) (canonical envelope, backbone worker op-order, Redis/flush machinery, skew/seal/dedup, provenance, logical-day) and [`../001-analytics-platform/ops-envelope.md`](../001-analytics-platform/ops-envelope.md) (scale/backpressure, rate-limit, GDPR, secrets). This story sits on that base; it is otherwise the foundation every other story rides on and depends on nothing else.
**Spec coverage:** US1, FR-001..004 (tenancy/identity), FR-005..008c (ingestion/schema).
**Excluded here** (→ [design.md](./design.md)): queue choice, worker layout, key layouts, DDL, wire format.

This spec synthesizes the US1 story frame with the deeper per-metric calculation sheet (the "Raw & Custom Events / Event Catalog" metric). The `## Design` section lives in [design.md](./design.md).

---

## 1. Story understanding

**The story.** A developer registers a game in the platform, gets an SDK key and the platform's fixed ingest endpoint (`/v1/events`, Q9 — `game_id` is derived from the key, not a per-game URL path), drops the SDK into their Phaser/React game, fires events, and **watches the counts increment** within minutes — for their game, and only their game.

**The question it answers.** *"Is my game sending data, and what is it sending?"* This is the "counting up" first-run experience an operator sees within minutes of dropping the SDK in, and the substrate every other metric rides on. Two coupled deliverables:
1. **The event catalog** — a self-populating, per-game registry of every event *name* seen, with its kind, first/last-seen, cumulative count, and the property keys observed on it. Derived metadata about the stream — never a raw event store.
2. **Live counts & top-N** — the current-UTC-day count per event name and the grand total, plus the top-N names by volume — the number that visibly ticks up as events arrive.

**What it means for the operator.** Confidence the integration works, a live pulse of volume, and a dashboard that fills itself in — no pre-declaring event schemas. Only the three reserved typed kinds (`economy` / `purchase` / `session`) are strictly validated; everything else is accepted permissively (**hybrid accept-all**, §H) so the operator can invent an event and see it appear the same minute.

**Variant chosen (§H): hybrid accept-all + strict-typed-kind.** A "generic" event is any `name` outside the three reserved kinds; it is accepted with an arbitrary `props` bag, never rejected for shape, and its name is auto-registered on first sight. Only the three reserved typed kinds are strictly validated before they feed their downstream metrics. **Rejected variants:**
- **strict-registry-only** (every name pre-declared) — kills US1's "fire an event and watch it appear," and the operator is the only tenant so an approval gate buys nothing.
- **fully schema-less, no catalog** — loses the self-populating dashboard and the cardinality guardrail that stops a buggy client from exploding the name space.

The hybrid mirrors GA4 / Amplitude-Observe / Segment-Protocols: permissive ingest, strict only on the shapes that power built-in reports.

**Trust boundary.** Client-sent generic events are the untrusted, spoofable majority — acceptable, because the catalog and raw counts make no money/economy claim. The **server SDK** may also emit named events into the *same* catalog (server events still carry `event_id`); they register into the same catalog, distinguished only by which SDK sent them, not by a separate catalog. Reserved typed kinds carry their own required fields (specified in their own stories); this story only requires that the *presence/absence* of those required fields is the drop-vs-quarantine decision (§6). Money/economy trust is a later story's concern.

---

## 2. How it is calculated

**Time-bucketing.** The platform **logical day** ([Foundation §4.7](../001-analytics-platform/foundation.md) — `utc_day(corrected + reporting_offset)`, single platform timezone; every "UTC day" below reads as the logical day), on skew-corrected client-event-time. The skew formula is `corrected = client_event_time + (server_received_time − client_sent_time)`, dead-band 60 s, future-clamped to server-now. Catalog `first_seen` / `last_seen` use the same corrected time.

**Grain.** Catalog = per `game_id` × `event_name`. Counts = per `game_id` × `event_name` × UTC-day (and a per-`game_id` × UTC-day grand total). **No cohort/user grain** — the catalog is stream-level and touches no per-user spine.

**Catalog upsert** (per accepted generic event, name `e`, game `g`):
- `first_seen(g,e) = min(existing, corrected_time)`; `last_seen(g,e) = max(existing, corrected_time)`.
- `count(g,e) += 1` **only if it survived dedup** (a repeat `event_id` within 24 h is a no-op). Count is explicitly **approximate-OK** (a duplicate beyond the 24 h window may double-count — §F accepted tradeoff for non-money events).
- For each key `k` in `props`: add the observed value-type to the **type-set** `property_keys(g,e)[k]` (a *set*, not last-write-wins — mixed types raise a drift flag, never a rejection). If `|property_keys(g,e)|` already `= property_key_cap_per_event` and `k` is new → skip `k`.
- If `e` is a new name and the game already holds `event_name_cap_per_game` names → **drop-and-count** into `dropped_capexceeded(g)`; do not register.

**Live count.** `live_count(g,e,day)` = Σ accepted events named `e` whose corrected UTC day = `day`. Grand total `live_total(g,day)` = Σ over names.

**Top-N.** Rank names by `count` (all-time) or `live_count(…,today)` (live view); take `top_n_events`; ties broken by `last_seen` desc (most recently active first).

**Partial-window handling.** Today's live count is **provisional** (Redis-live, the last ~5 min may be unflushed; §E-2). Do not mark it N/A — it is expected to grow; the UI notes "provisional." Sealed days (> 48 h old) are final Postgres values.

### Worked example

Game `g=42`, a fresh integration. Cap 500, `property_key_cap_per_event` 50, `top_n_events = 3`. Over one UTC day the collector accepts (post-dedup, post-skew) this stream:

| name | kind | count today | notes |
|---|---|---|---|
| `level_start` | generic | 1 200 | props `{level:int, mode:str}` |
| `button_click` | generic | 3 050 | props `{id:str}` |
| `screen_view` | generic | 900 | props `{screen:str}` |
| `economy` | economy | 400 | strict path — validated, counts if valid |
| `session` | session | 260 | strict path |
| `boss_hit` | generic | 75 | first seen this day |

Plus 40 events with an empty `name`, 12 JSON-unparseable bodies, and 5 `economy` events missing `amount`.

- **Catalog** now has 6 named rows. `boss_hit.first_seen` = its first corrected-time today; all six `last_seen` = their last today. `level_start.property_keys = {level:{int}, mode:{str}}`. If a later `level_start` arrives with `level:"12"` (string), `property_keys[level]` becomes `{int,str}` and a **drift flag** is raised (§H-1) — the event still counts.
- **live_total(42, today)** = 1200 + 3050 + 900 + 400 + 260 + 75 = **5 885** accepted.
- **Top-3 by volume**: `button_click` (3050), `level_start` (1200), `screen_view` (900).
- **Dropped-and-counted**: `dropped_nameless(42)` += 40, `dropped_unparseable(42)` += 12 → drop tally **52** (surfaced, excluded from every rollup).
- **Quarantined**: the 5 malformed `economy` events → written to the raw file's quarantine, `quarantined_typed(42)` += 5; they do **not** count in the `economy` catalog row's 400 nor in any economy rollup.
- Name-cap check: `|names(42)|` = 6 ≪ 500, so `boss_hit` registered normally.

---

## 3. Data needed (input)

This story consumes the **canonical envelope as-is** — it adds no new required field. What it needs from every event:

| Field | Why this story needs it | Req/Opt | Source of truth |
|---|---|---|---|
| `game_id` | Tenant scope; every catalog row and counter is per-game (server-derived from SDK-key auth). | required | SDK-key auth (server-derived) |
| `name` | The registry key — a free-form string or a reserved-kind name. | required (non-empty) | client (or server SDK) |
| `kind` | Routes accept-all (`generic`) vs strict (`economy`/`purchase`/`session`). Defaults to `generic` if absent but `name` present. | required | client-declared; reserved-name collision override per §H-2 |
| `props` | Free-form bag; its **keys + observed value-types** populate the catalog. Values themselves are *not* stored by the catalog (only key + type). | optional | client |
| `event_id` | Per-event dedup key so a duplicate does not inflate the count (§F). | required | client-generated |
| `client_event_time` / `client_sent_time` | Feed skew-correction → decide which UTC day a count lands in (§G). | required | client |
| `server_received_time` | Collector stamp; other half of the skew formula; fallback bucket for nameless-drop counters. | required | server (collector) |

Minimum viable input for this story: a **stable, non-empty `name`** and a **parseable JSON body**. Absent either → dropped-and-counted (§6).

**Registration input (one-time, per game).** To register a game the operator supplies a name; the platform returns a unique **SDK key** (public `sdk_key`) and the fixed ingest endpoint (`POST /v1/events`, Q9). Every ingest request authenticates by SDK key, and **`game_id` + `provenance` are derived server-side from the key's class** ([Foundation §4.5](../001-analytics-platform/foundation.md)) — there is no per-game URL path to scope by. Invalid/unknown keys are rejected with nothing recorded (FR-003).

---

## 4. Data stored for longer-run processing

Durable, derived-metadata only — never raw events. This is the data-shape requirement (WHAT must be derivable, not how it is stored):

- **Event catalog (per game × event name):** `kind`, `first_seen`, `last_seen`, cumulative `count` (approximate-OK), `property_keys` as key → **observed-type set**, and a `status` (`unexpected`/`accepted` for future Amplitude-style promotion; v1 sets every name `accepted` on first sight). One row per discovered name — derived metadata, not a raw event store.
- **Count rollups (per game × name × UTC-day, and per game × UTC-day grand total):** accepted-event counts, enough to render live counts and rank top-N without touching raw events. Sealed days are final; today is provisional.
- **Exception tallies (per game):** running counts of `dropped_nameless`, `dropped_unparseable`, `dropped_capexceeded`, `quarantined_typed` — counters only, no payloads — kept both per-UTC-day (for "what happened today") and lifetime (for health monitoring).
- **Distinct registered-name count (per game):** to enforce the 500-name cap.

**No per-user spine.** Deliberate — the catalog stores no `user_id`, sets no retention bit, keeps no per-user history. This is what keeps it results-only-cheap and honors SC-007.

**Computable without raw re-scan? ✅ Yes.** Everything here is an **incremental upsert at ingest** (min/max for seen-times, +1 for counts, set-union for property types). The catalog *is* the accumulated result; it is never re-derived by scanning the raw file. The only thing the raw file holds that the catalog does not is the quarantine tail (late/malformed typed events), which by §G/§H is intentionally excluded from these aggregates.

---

## 5. Data-structure thinking — Redis & database

*Conceptual shapes only. Actual keys / DDL are a [design.md](./design.md)-level decision.*

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
| `event_name_cap_per_game` | 500 | 1–10000 (GA4 precedent 500) | **Forward-only** for new names. Already-registered names are never evicted by lowering it; names beyond the cap are dropped-and-counted from the moment it is hit. Raising it lets new names register going forward. |
| `property_key_cap_per_event` | 50 | 1–1000 | **Forward-only.** Keys already observed on a name stay; new keys beyond the cap on that name are ignored (event still counts). |
| `top_n_events` | 10 | 1–100 | **Display-only, immediate** — a read-time ranking; mutates no stored aggregate. |
| `pii_prop_denylist` | **`[email, ip, phone, name, address, …]`** (default-DENY, 2026-07-17) | list of property-key names | **Forward-only** for the *config*, but ships a **non-empty default** — common PII keys are stripped at ingest **before** the raw-append out of the box, so one careless `props.email` never lands in a 90-day raw file or the catalog by default. Already-registered keys are scrubbed by the **one-shot catalog-scrub tool** ([ops-envelope §9](../001-analytics-platform/ops-envelope.md) — now specified to exist, no longer a bare "Open"). |
| `pii_prop_value_scrubber` | on | on / off | **Forward-only.** Regex value-scrubber (emails, IP addresses) applied at ingest **before** raw-append — catches PII in *values* even under a non-denylisted key. A catalog PII-warning surfaces when a match is observed. |
| `pii_prop_hash` | off | off / hash-listed-keys | **Forward-only**, same rationale. |
| `drop_counter_visible` | on | on / off | **Display-only** — whether the dashboard surfaces the dropped/quarantined tallies. |

**Inherited globals (referenced, not redefined here):** dedup window 24 h (§F), day-seal grace 48 h (§G), flush cadence 5 min (§E), per-game reporting timezone offset (display-only). Rationale for the forward-only defaults: the cap and denylist gate *ingestion*, and sealed aggregates / already-flushed catalog rows are immutable — a config change that reached backward would demand a forbidden raw re-scan.

---

## 7. Edge cases & failure modes

- **Nameless / unparseable event (§H, FR-008c):** dropped, never crashes a worker, **counted** into `dropped_nameless` / `dropped_unparseable`. Nameless events have no valid registry key; unparseable ones can't be inspected — dropping is the only safe move. The counter preserves observability (US1 "why is my total lower than I fired?").
- **Typed-kind missing required fields (§H):** an `economy`/`purchase`/`session` event lacking its required fields is **quarantined to the raw file** (the DLQ floor for a solo operator), not dropped — it may be recoverable in a future backfill. It does NOT increment its catalog row or any downstream rollup. Distinct from generic events, which are *never* quarantined for shape (they have no required shape).
- **Reserved-name collision (§H-2):** a free-form event whose `name` is `purchase`/`economy`/`session` is **always routed to the strict typed path**, regardless of the client-declared `kind`. The platform claims those three names; if the payload doesn't satisfy the strict schema it is quarantined (per above), not registered as a generic catalog entry. This prevents a client from shadowing a reserved kind with junk that would poison the economy/monetization/retention sheets.
- **Cardinality explosion (§H-4):** a buggy client emitting random names is capped at `event_name_cap_per_game` (500). Names beyond the cap are dropped-and-counted (`dropped_capexceeded`) and should alert the operator; the same guard applies per-event to property keys (`property_key_cap_per_event`). The already-registered set is never evicted — the cap gates *new* growth only, keeping the catalog bounded without losing established names.
- **Property-type drift (§H-1):** the same key arriving as string then number does **not** reject the event and does **not** last-write-wins; the observed-type **set** accumulates both and a drift flag is surfaced in the catalog. The operator diagnoses; ingestion never stalls.
- **PII in free-form props (§H-3):** accept-all can carry arbitrary keys, including PII, into `property_keys`. v1 relies on the solo-operator trust assumption plus a non-empty default `pii_prop_denylist` / value-scrubber / optional `pii_prop_hash` applied **forward at ingest**. Values are not stored by the catalog (only key names + types), which limits but does not eliminate exposure (a key *named* `email` still surfaces).
- **Dedup (§F):** a resent `event_id` within 24 h must not increment any count — dedup happens before the catalog upsert. Beyond 24 h a resend may double-count; explicitly accepted for these non-money events (counts are approximate-OK). Purchases are immune via the durable `transaction_id` path (their story).
- **Late / sealed-day events (§G):** an event whose corrected time lands on a day already sealed (> 48 h) is **quarantined to the raw file**, never folded into that day's live/sealed count — even a perfectly-valid generic event. Its catalog `last_seen` is likewise not advanced backward. This preserves §G day-seal determinism.
- **Clock skew (§G):** skew-corrected client time decides the count's UTC day; under-60 s skew trusts the client verbatim; future-dated clamps to server-now. A misclocked client therefore lands in the right day (or today) rather than a wrong bucket.
- **Redis loss (§E):** today's live counters are transient and may be lost — accepted, no replay. Because the raw file is appended write-ahead (before the counter update), the day's raw file remains a complete superset, so live counts are the *only* casualty and are rebuildable manually from raw if ever needed. Catalog rows flushed to Postgres (≤ 5 min ago) survive. Getting the write order wrong would create counted-but-unlogged events and break SC-008.

---

## 8. Open questions

- **§H-1 Property-type drift representation [LEANING].** Store a per-key **observed-type set** and raise a drift flag; do not reject or collapse to last-write-wins. *Default: type-set + drift flag; no ingestion impact.* (Adopted above.)
- **§H-2 Reserved-name collision [LEANING].** *Default: the three reserved names always route to the strict typed path and quarantine if malformed; the name is platform-owned and cannot be registered as generic.* (Adopted above.)
- **§H-3 PII in free-form props [OPEN].** *Recommendation: config `pii_prop_denylist` + optional `pii_prop_hash`, applied forward at ingest; document that free-form props are operator-trusted.* **Sub-question:** should a denylist change retro-scrub already-registered keys? *Default: no (forward-only, matches §E/§G immutability); a manual one-shot catalog-scrub tool is offered as a separate operator action ([ops-envelope §9](../001-analytics-platform/ops-envelope.md)), not an automatic config side-effect.*
- **§H-4 Cardinality caps [LEANING].** *Default: `event_name_cap_per_game`=500, `property_key_cap_per_event`=50; drop-and-count + alert beyond; never evict established entries.* (Adopted above.)
- **Catalog `status` promotion semantics [OPEN].** The `status` field (`unexpected`/`accepted`) is carried for future Amplitude-style promotion but v1 defines no promotion action. *Recommendation: v1 sets every registered name to `accepted` on first sight (no gate); reserve `unexpected` and the promotion workflow for a later release — carrying the field now keeps it a non-breaking upgrade.*
- **Count semantics for exception tallies [LEANING].** Whether `dropped_*` / `quarantined_typed` are per-UTC-day (seal with the day) or lifetime running totals. *Default: maintain both a per-UTC-day figure and a lifetime total; both are derivable incrementally, neither needs raw re-scan.*
- **Missing `event_id` on a generic event (design open Q).** Realized as drop-and-tally under `unparseable` (an undedupable event would void the §F 24 h guarantee); the deeper sheet's "name + parseable body is enough" reading would instead accept-without-dedup. Default: drop; flag if accept-undeduped is wanted.
- **Grand total as read-time Σ (design open Q).** §4 lists a stored per-game×day grand total; the design derives it read-time from `EVENT_DAY_COUNT` (cap-bounded, drift-free, still raw-re-scan-free). Flag if a stored cell is preferred.
- **Depends-on — session definition (LOCKED).** The reserved `session` kind's required fields (`session_id`, start/end, `duration_ms`) are fixed by the Sessions decision ([003-sessions](../003-sessions/spec.md)); this story only needs *presence* of those fields for its drop-vs-quarantine test, so no residual blocker.

---

## Cross-references

- **Shared base:** [`../001-analytics-platform/foundation.md`](../001-analytics-platform/foundation.md) — canonical envelope, backbone worker op-order, Redis/flush machinery, skew/seal/dedup regimes, provenance, logical-day; [`../001-analytics-platform/ops-envelope.md`](../001-analytics-platform/ops-envelope.md) — scale/backpressure, rate-limit, GDPR, secrets.
- **Design:** [design.md](./design.md) realizes §1–8 against the shared foundation.
- **Feeds every later story:** the accept-all substrate (this story) is what [003-sessions](../003-sessions/spec.md), [004-economy](../004-economy/spec.md), [005-retention](../005-retention/spec.md), and [006-monetization](../006-monetization/spec.md) validate their reserved kinds *within*; [008-cold-storage](../008-cold-storage/spec.md) owns the raw day-file lifecycle this story appends to.
