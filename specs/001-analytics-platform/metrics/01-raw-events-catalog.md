# Metric Spec Sheet: Raw & Custom Events (Event Catalog)

**Feature**: 001-analytics-platform · **Phase**: research/specify · **Status**: Draft
**Depends on**: Canonical event envelope · §F dedup (`event_id` + 24h) · §G event-time (skew-corrected UTC, 48h seal) · §H schema policy · §E write-ahead raw file · Sessions decision (reserved `session` kind). This is the **foundational substrate** every other sheet (economy, retention, monetization) sits on.

## 1. Purpose & Definition

Answers the US1 P1 question: *"is my game sending data, and what is it sending?"* — the "counting up" experience an operator sees within minutes of dropping the SDK in. This is the accept-all ingestion layer plus the self-populating **event catalog** (§H): every free-form named event is accepted, auto-registered, and surfaced with live and historical counts; only the three reserved typed kinds (`economy`/`purchase`/`session`) are strictly validated before they feed their downstream metrics.

**Definition — two coupled deliverables:**
1. **Event catalog** (per game): the set of discovered event names, each with `kind`, first/last-seen, cumulative count, observed property keys→type-set, and status. This is *derived metadata about the stream*, never a raw event store.
2. **Live event counts & top-N by volume** (per game): current-UTC-day count per event name (and grand total), plus the top-N names ranked by count — the number that visibly increments as events arrive.

**Variant chosen (§H): hybrid accept-all + strict-typed-kind.** A "generic" event is any `name` outside the three reserved kinds; it is accepted with an arbitrary `props` bag, never rejected for shape, and its name is auto-registered on first sight. Rejected variants: **strict-registry-only** (every name pre-declared) — kills US1's "fire an event and watch it appear," and the operator is the only tenant so an approval gate buys nothing; **fully schema-less, no catalog** — loses the self-populating dashboard and the cardinality guardrail that stops a buggy client from exploding the name space. The hybrid mirrors GA4/Amplitude-Observe/Segment-Protocols: permissive ingest, strict only on the shapes that power built-in reports.

## 2. SDK Data Captured

This metric consumes the **canonical envelope as-is** — it adds no new required fields. It uses:

| Field | Meaning for this metric | Req/Opt | Source of truth |
|---|---|---|---|
| `game_id` | Tenant scope; every catalog row and counter is per-game. | required | SDK-key auth (server-derived) |
| `name` | The registry key. Free-form string OR a reserved kind name. | required | client (or server SDK) |
| `kind` | `generic` \| `economy` \| `purchase` \| `session`. Routes to accept-all vs strict path. | required (defaults to `generic` if absent but `name` present) | client-declared; reserved-name collision override per §H-2 |
| `props` | Free-form property bag. Its **keys and observed value-types** are what populate the catalog's `property_keys`. Values themselves are NOT stored by the catalog (only key+type). | optional | client |
| `event_id` | Per-event dedup key; a duplicate must not inflate the count (§F). | required | client-generated |
| `client_event_time` / `client_sent_time` | Feed skew-correction → decides which UTC day a count lands in (§G). | required | client |
| `server_received_time` | Collector stamp; other half of the skew formula; also the fallback bucket for a nameless drop-counter. | required | server (collector) |

**Trust boundary:** client-sent generic events are the untrusted, spoofable majority — fine, because the catalog and raw counts make no money/economy claim. The **server SDK** may also emit named events (§F-3: server events still carry `event_id`); they register into the same catalog, distinguished only by which SDK sent them, not by a separate catalog. Reserved typed kinds carry their own required fields (specified in their own sheets); this sheet only requires that the *presence/absence* of those required fields is the drop-vs-quarantine decision (see §6).

No new field is required. What this metric needs from the SDK is a **stable, non-empty `name`** and a **parseable JSON body**; absent either, the event is dropped-and-counted (§6).

## 3. Admin Configuration

| Knob | Default | Range / values | Retro or Forward |
|---|---|---|---|
| `event_name_cap_per_game` | 500 | 1–10000 (GA4 precedent 500) | **Forward-only** for *new* names (a name already registered is never evicted by lowering the cap; names beyond the cap are dropped-and-counted from the moment the cap is hit). Raising it lets new names register going forward. |
| `property_key_cap_per_event` | 50 | 1–1000 | **Forward-only.** Keys already observed on a name stay; new keys beyond the cap on that name are ignored (event still counts). |
| `top_n_events` | 10 | 1–100 | **Display-only**, applies immediately (it is a read-time ranking, mutates no stored aggregate). |
| `pii_prop_denylist` | `[]` (empty) | list of property-key names (§H-3) | **Forward-only** — denylisted keys are stripped/omitted from the catalog on ingest; already-registered keys are not retro-scrubbed by a config change (call out as Open Q §H-3). |
| `pii_prop_hash` | off | off \| hash-listed-keys | **Forward-only**, same rationale. |
| `drop_counter_visible` | on | on \| off | Display-only. Whether the dashboard surfaces the dropped/quarantined tallies. |

Inherited-but-relevant locked knobs (do **not** redefine): dedup window (24h, §F), day-seal grace (48h, §G), Postgres flush cadence (5 min, §E). Rationale for the forward-only defaults: the cap and denylist gate *ingestion*, and per §G/§E sealed aggregates and already-flushed catalog rows are immutable — a config change that reached backward would require a raw re-scan, which is forbidden.

## 4. Calculation

**Catalog upsert (per observed event, generic path):**
For each accepted event with name `e` in game `g`:
- `first_seen(g,e)` = min(existing, corrected_event_time); `last_seen(g,e)` = max(existing, corrected_event_time).
- `count(g,e)` += 1 *only if the event survived §F dedup* (a repeat `event_id` within 24h is a no-op). Count is explicitly **approximate-OK** (a duplicate beyond the 24h window may double-count; §F accepted tradeoff for non-money events).
- For each key `k` in `props`: add `observed_type(props[k])` to the type-set `property_keys(g,e)[k]` (§H-1: a set, not last-write-wins). If `|property_keys(g,e)|` already = `property_key_cap_per_event` and `k` is new → skip `k`.
- If `e` is new and `|names(g)|` already = `event_name_cap_per_game` → **drop-and-count** into `dropped_capexceeded(g)`, do not register.

**Live count (current UTC day):** `live_count(g,e,day) = Σ accepted events named e in game g whose corrected-event-time UTC day = day`. Grand total `live_total(g,day) = Σ_e live_count(g,e,day)`.

**Top-N by volume:** rank names by `count` (all-time) or by `live_count(...,today)` (live view); return the first `top_n_events`. Ties broken by `last_seen` desc (most recently active first).

**Time-bucketing:** UTC day, by **skew-corrected client-event-time** (§G) — `corrected = client_event_time + (server_received_time − client_sent_time)`, dead-band 60s, future-clamped to server-now. Catalog `first/last_seen` use the same corrected time. **Grain:** per `game_id` × `event_name` (catalog) and per `game_id` × `event_name` × UTC-day (counts). No cohort/user grain — the catalog is stream-level, not per-user (it touches no user spine).

**Partial-window handling:** today's live count is **provisional** (Redis-live, last ~5 min may be unflushed; §E-2). Do not mark it N/A — it is expected to grow; the UI notes "provisional." Sealed days (>48h old) are final Postgres values.

### Worked example

Game `g=42`, a fresh integration. Cap 500, `property_key_cap_per_event` 50, `top_n_events`=3. Over one UTC day the collector accepts (post-dedup, post-skew) this stream:

| name | kind | count today | notes |
|---|---|---|---|
| `level_start` | generic | 1 200 | props `{level:int, mode:str}` |
| `button_click` | generic | 3 050 | props `{id:str}` |
| `screen_view` | generic | 900 | props `{screen:str}` |
| `economy` | economy | 400 | strict path — validated, counts if valid |
| `session` | session | 260 | strict path |
| `boss_hit` | generic | 75 | first seen this day |

Plus 40 events with an empty `name`, and 12 JSON-unparseable bodies, and 5 `economy` events missing `amount`.

- **Catalog** now has 6 named rows. `boss_hit.first_seen` = its first corrected-time today; all six `last_seen` = their last today. `level_start.property_keys = {level:{int}, mode:{str}}`. If a later `level_start` arrives with `level:"12"` (string), `property_keys[level]` becomes `{int,str}` and a **drift flag** is raised (§H-1) — the event still counts.
- **live_total(42, today)** = 1200+3050+900+400+260+75 = **5 885** accepted.
- **Top-3 by volume**: `button_click` (3050), `level_start` (1200), `screen_view` (900).
- **Dropped-and-counted**: `dropped_nameless(42)` += 40, `dropped_unparseable(42)` += 12 → drop tally **52** (surfaced, excluded from every rollup).
- **Quarantined**: the 5 malformed `economy` events → written to the raw file's quarantine, `quarantined_typed(42)` += 5; they do **not** count in the `economy` catalog row's 400 nor in any economy rollup.
- Name-cap check: `|names(42)|` = 6 ≪ 500, so `boss_hit` registered normally.

## 5. Data-Shape Requirements (WHAT must be derivable — NOT how it's stored)

- **Per `game_id` × `event_name`**, we must produce: `kind`, `first_seen`, `last_seen`, cumulative `count` (approximate-OK), `property_keys` as a map of key → **observed-type set**, and `status` (`unexpected`/`accepted` for future Amplitude-style promotion; §H). This is the catalog — derived metadata, one row per discovered name.
- **Per `game_id` × `event_name` × UTC-day**, we must produce an accepted-event `count`, and per `game_id` × UTC-day a grand total — enough to render live counts and rank top-N without touching raw events.
- **Per `game_id`**, we must produce running tallies of the three exception classes: `dropped_nameless`, `dropped_unparseable`, `dropped_capexceeded`, and `quarantined_typed` — counters only, no payloads.
- **Per `game_id`**, the count of distinct registered names (to enforce the 500 cap) must be derivable.
- **No per-user spine requirement.** The catalog is deliberately stream-level; it stores no `user_id`, sets no retention bit, keeps no per-user history. This is what keeps it results-only-cheap.
- **Computable without raw re-scan?** ✅ Yes. Every quantity is an incremental upsert applied at ingest (min/max for seen-times, +1 for counts, set-union for property types). The catalog *is* the accumulated result; it is never re-derived by scanning the raw file. The only thing the raw file holds that the catalog does not is the quarantine tail (late/malformed typed events), which by §G/§H is intentionally excluded from these aggregates. NO DDL, NO column types, NO Redis keys implied by any of the above.

## 6. Edge Cases & Failure Modes

- **Nameless / unparseable event (§H, FR-008c):** dropped, never crashes a worker, **counted** into `dropped_nameless` / `dropped_unparseable`. Nameless events have no valid registry key; unparseable ones can't be inspected — dropping is the only safe move. The counter preserves observability (US1 "why is my total lower than I fired?").
- **Typed-kind missing required fields (§H):** an `economy`/`purchase`/`session` event lacking its required fields is **quarantined to the raw file** (the DLQ floor for a solo operator), not dropped — it may be recoverable in a future backfill. It does NOT increment its catalog row or any downstream rollup. Distinct from generic events, which are *never* quarantined for shape (they have no required shape).
- **Reserved-name collision (§H-2):** a free-form event whose `name` is `purchase`/`economy`/`session` is **always routed to the strict typed path**, regardless of the client-declared `kind`. The platform claims those three names; if the payload doesn't satisfy the strict schema it is quarantined (per above), not registered as a generic catalog entry. This prevents a client from shadowing a reserved kind with junk that would poison the economy/monetization/retention sheets.
- **Cardinality explosion (§H-4):** a buggy client emitting random names is capped at `event_name_cap_per_game` (500). Names beyond the cap are dropped-and-counted (`dropped_capexceeded`) and should alert the operator; the same guard applies per-event to property keys (`property_key_cap_per_event`). The already-registered set is never evicted — the cap gates *new* growth only, keeping the catalog bounded without losing established names.
- **Property-type drift (§H-1):** the same key arriving as string then number does **not** reject the event and does **not** last-write-wins; the observed-type **set** accumulates both and a drift flag is surfaced in the catalog. The operator diagnoses; ingestion never stalls.
- **PII in free-form props (§H-3):** accept-all can carry arbitrary keys, including PII, into `property_keys`. v1 relies on the solo-operator trust assumption plus optional `pii_prop_denylist` / `pii_prop_hash` applied **forward at ingest**. Values are not stored by the catalog (only key names + types), which limits but does not eliminate exposure (a key *named* `email` still surfaces).
- **Dedup (§F):** a resent `event_id` within 24h must not increment any count — dedup happens before the catalog upsert. Beyond 24h a resend may double-count; explicitly accepted for these non-money events (counts are approximate-OK). Purchases are immune via the durable `transaction_id` path (their sheet).
- **Late / sealed-day events (§G):** an event whose corrected time lands on a day already sealed (>48h) is **quarantined to the raw file**, never folded into that day's live/sealed count — even a perfectly-valid generic event. Its catalog `last_seen` is likewise not advanced backward. This preserves §G day-seal determinism.
- **Clock skew (§G):** skew-corrected client time decides the count's UTC day; under-60s skew trusts the client verbatim; future-dated clamps to server-now. A misclocked client therefore lands in the right day (or today) rather than a wrong bucket.
- **Redis loss (§E):** today's live counters are transient and may be lost — accepted, no replay. Because the raw file is appended write-ahead (before the counter update), the day's raw file remains a complete superset, so live counts are the *only* casualty and are rebuildable manually from raw if ever needed. Catalog rows flushed to Postgres (≤5 min ago) survive. Getting the write order wrong would create counted-but-unlogged events and break SC-008.

## 7. Open Questions

- **§H-1 Property-type drift representation [LEANING].** Store a per-key **observed-type set** and raise a drift flag; do not reject or collapse to last-write-wins. *Default: type-set + drift flag; no ingestion impact.* (Adopted above.)
- **§H-2 Reserved-name collision [LEANING].** *Default: the three reserved names always route to the strict typed path and quarantine if malformed; the name is platform-owned and cannot be registered as generic.* (Adopted above.)
- **§H-3 PII in free-form props [OPEN].** *Recommendation: config `pii_prop_denylist` + optional `pii_prop_hash`, applied forward at ingest; document that free-form props are operator-trusted.* **New sub-question surfaced:** should a denylist change retro-scrub already-registered keys? *Default: no (forward-only, matches §E/§G immutability); offer a manual one-shot catalog-scrub tool as a separate operator action, not an automatic config side-effect.*
- **§H-4 Cardinality caps [LEANING].** *Default: `event_name_cap_per_game`=500, `property_key_cap_per_event`=50; drop-and-count + alert beyond; never evict established entries.* (Adopted above.)
- **New — catalog `status` promotion semantics [OPEN].** The `status` field (`unexpected`/`accepted`) is carried for future Amplitude-style promotion but v1 defines no promotion action. *Recommendation: v1 sets every registered name to `accepted` on first sight (no gate); reserve `unexpected` and the promotion workflow for a later release — carrying the field now keeps it a non-breaking upgrade.*
- **New — count semantics for exception tallies [LEANING].** Whether `dropped_*` / `quarantined_typed` are per-UTC-day (seal with the day) or lifetime running totals. *Default: maintain both a per-UTC-day figure (for "what happened today") and a lifetime total (for health monitoring); both are derivable incrementally, neither needs raw re-scan.*
- **Depends-on — session definition (§X-2, LOCKED).** The reserved `session` kind's required fields (`session_id`, start/end, `duration_ms`) are fixed by the Sessions decision; this sheet only needs *presence* of those fields for its drop-vs-quarantine test, so no residual blocker — noted for cross-reference.
