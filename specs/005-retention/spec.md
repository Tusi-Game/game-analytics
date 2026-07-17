# Retention (Classic Day-N)

**Part of**: [001-analytics-platform](../001-analytics-platform/spec.md)
**Story**: US3 (P2) · **Reserved kind**: consumes `session` (owns none) · **Status**: Draft
**Spec refs**: US3, FR-015 / FR-016 / FR-017.
**Depends on**: [002-foundation-ingest](../002-foundation-ingest/spec.md) (ingest), [003-sessions](../003-sessions/spec.md) (sessions — activeness anchor; the session-start bit is retention's only input).
**Shared substrate**: [foundation.md](../001-analytics-platform/foundation.md) (envelope, skew, seal, dedup, flush machinery — cited as "Foundation §N", never re-derived); bridge [02.5-activeness-spine-contract](../001-analytics-platform/bridges/02.5-activeness-spine-contract.md) (spine write-delegation contract).

> This spec synthesizes the story-level frame (phase §1–6) with the deeper per-metric sheet (fuller calculation, worked example, edge-case catalog, data-shape requirements). Where the two framings differ, the **platform logical day** framing (Foundation §4.7, 2026-07-17 timezone fix) is authoritative; the metric sheet's earlier "UTC day" wording is preserved in the edge-case and open-question catalogs as originally written, with the logical-day fix noted where it applies. Design realization (ER, Redis, worker flow) lives in [design.md](./design.md).

---

## 1. Story understanding

**The story.** The developer sees how many players return on day 1, day 7, and day 30 after their first session — each as a percentage of that install-date cohort.

**The question it answers.** *Of the players who first appeared on a given calendar day (an install-date cohort), what fraction were still active exactly N days later?* Retention is the headline health metric — D1 caps everything downstream — and it is the metric that drove the "minimal per-user spine" storage decision.

**Definition (LOCKED — classic Nth-day / "On" retention):**
> `D_N = retained_users(offset = N) / cohort_size`, grouped by install-date cohort, where a user counts toward `offset = N` iff they were **active on the day exactly N days after their `first_seen` day** (the platform **logical day**, Foundation §4.7). Independent per offset; stable and write-once once day N of a cohort has elapsed.

The classic Day-N definition is **retained unchanged** — the 2026-07-17 timezone fix (Foundation §4.7) moves only *which calendar the day is measured against* (platform logical day = the operator's local midnight, e.g. Asia/Tehran +3:30) from raw UTC to the single platform timezone. For a single-timezone player base this eliminates the systematic D1 deflation from UTC-day cohorting (the local 00:00→offset band being misattributed to the previous UTC day; devtodev: 4–5 pp on a ~30 % base). Benchmarks (D1≈40 / D7≈20 / D30≈10, themselves calendar-day figures) and the "classic Day-N" UI label survive.

The dashboard MUST label this **"classic Day-N retention."**

**Rejected variants.** *Range / bracket* (active on day N *or later within a bracket* — more forgiving, higher numbers; not the reference metric) and *rolling / unbounded* (Mixpanel's "On or After" default — active on day N *or any later day*; **disqualified by results-only storage**). Rolling's per-cell test `max(active_offsets) ≥ N` depends on a *future* maximum: a late return retroactively bumps *earlier* day-N cells → requires retroactively rewriting already-sealed heatmap cells, impossible without per-user return history or a raw event re-scan — both forbidden in v1. Classic's test is `N ∈ active_offsets` — idempotent, order-independent, write-once. **This is the load-bearing reason for the choice:** it is the only definition computable from incremental results + a minimal spine.

**Trust boundary.** Retention is a **client-behavior** metric (players return by playing), so the client `session` event is the accepted source; there is no money / economy trust concern here. Server SDK sessions are out of scope in v1 (server events inherit a passed-in `session_id` or none), so server-side activity does not, on its own, mark a retention day.

**What it means for the operator.** A retention curve and the full cohort heatmap triangle from a spine of a few small columns per user — no raw event history.

---

## 2. How it is calculated

**Grain / bucketing.**
- **Cohort** = `logical_day(first_seen)` (Foundation §4.7), per `game_id`. (Metric-sheet framing: install-date cohort = `date_utc(first_seen)`; the logical-day fix substitutes the platform logical day for raw UTC.)
- **Day-offset** = `logical_day(session_start_time) − logical_day(first_seen)`, on skew-corrected time floored through the platform `reporting_offset`. Offset 0 = install day.
- **Bit-set rule (idempotent):** for each qualifying `session` event, if the user's bit for `offset` is unset, set it and increment `retained_users(game, cohort, offset)`. Setting an already-set bit is a **no-op** — this makes reprocessing, dedup misses, and midnight-span-splits safe (FR-016).
- A midnight-spanning session counts once, in its **start** day (per the sessions decision); only that start-day bit is set. Duration may be split pro-rata for other metrics, but retention uses start-day only.

**Formulas:**
```
cohort_size(g, c)       = # distinct users with date_utc(first_seen) = c   (game g)
retained_users(g, c, N) = # users in cohort (g,c) whose active-offset set contains N
D_N(g, c)               = retained_users(g, c, N) / cohort_size(g, c)
headline D_N(g)         = Σ_c retained_users(g,c,N) / Σ_c cohort_size(g,c)   over the FIXED mature-cohort set (below)
```
D1 / D7 / D30 are columns N = 1 / 7 / 30 of the same table; the cohort × offset triangle **is** the heatmap. Same definition drives headline and heatmap automatically.

**Headline composition guard (added 2026-07-17 — the survivorship / mixed-maturity bias).** Averaging D_N across cohorts of *mixed maturity* biases the blended number, and it **drifts** as immature cohorts mature and un-mask — pure composition change with zero behavioral change (a documented 45 %→70 % artifact). Two rules contain it: (1) the headline averages over the **fixed set of cohorts that are all mature at N** (a cohort enters the D_N average only once it is mature at N, and the set is stated, so the number is not a silently-moving survivor-weighted average); (2) the default retention surface is the **cohort × offset heatmap triangle, not a single blended line**, so composition is visible. The blended headline is explicitly labeled composition-dependent (not a behavioral constant). This is a read-model rule; no stored cell changes.

**Immature-cohort masking:** mask (render **N/A**, never a low number) any cell where `today_logical − cohort_date < N` (day N not yet elapsed; `today_logical` = the platform logical today, Foundation §4.7 — computing it in raw UTC would leave the mask edge off by up to one day near the boundary). Headline averages **mature cohorts only** — a cohort installed 3 days ago must not drag D7/D30 toward zero.

**Small-cohort masking (added 2026-07-17 — the sample-size guard, orthogonal to maturity).** A cohort can be *mature* at offset N yet *tiny*: a 12-install cohort reading D30 = 16.7 % (2/12) carries a Wilson 95 % CI of roughly [4.7 %, 44.8 %] — a ~40-point band shown with the same visual authority as an n = 50 000 figure. Cells whose denominator (`cohort_size`, or the segment's sub-denominator) is below **`retention_min_cohort_size`** (default 30) are masked **low-confidence** (greyed + a sample-size annotation, never hidden, never a bare precise-looking percent); the maturity mask and this mask are independent predicates and both apply. Segmented retention views (retention × region × payer-tier) shred cohorts into dozens of installs, so this guard is load-bearing there. A cohort-vs-cohort "X beats Y" callout is gated behind a two-proportion / χ² test, never a raw point comparison.

### Worked example (today = 2026-07-17 UTC)

Game `g`. Reporting "today" = **2026-07-17 (UTC)**. Three cohorts:

**Cohort A — install date 2026-06-01** (46 days elapsed, so D1 / D7 / D30 all mature), size 200.
Active-offset tallies (users whose bit is set at that offset):
- offset 1: 82 users → **D1 = 82/200 = 41.0 %**
- offset 7: 46 users → **D7 = 46/200 = 23.0 %**
- offset 30: 22 users → **D30 = 22/200 = 11.0 %**

**Cohort B — install date 2026-07-14** (3 days elapsed), size 150.
- offset 1: 63 users → **D1 = 63/150 = 42.0 %** (day 1 elapsed → mature)
- offset 7: `today − cohort = 3 < 7` → **D7 = N/A (masked)**
- offset 30: `3 < 30` → **D30 = N/A (masked)**

**Cohort C — install date 2026-07-16** (1 day elapsed), size 90.
- offset 1: `today − cohort = 1`, so day 1 has *just* elapsed → mature. 41 users → **D1 = 41/90 = 45.6 %**
- offset 7, 30 → **N/A (masked)**

**Headline (mature cohorts only):**
- Headline D1 = (82+63+41) / (200+150+90) = 186 / 440 = **42.3 %** (all three cohorts have an elapsed day 1)
- Headline D7 = 46 / 200 = **23.0 %** (only Cohort A is mature at offset 7)
- Headline D30 = 22 / 200 = **11.0 %** (only Cohort A is mature at offset 30)

Note how B and C contribute to D1 but are *excluded* from D7/D30 — without masking, D7 would falsely read `46/440 = 10.5 %` because 290 users hadn't had the chance to reach day 7.

**Heatmap triangle** (rows = cohort, cols = offset; `—` = masked / not-yet-elapsed):

| Cohort | size | off 0 | off 1 | off 7 | off 30 |
|---|---|---|---|---|---|
| A (06-01) | 200 | 100% | 41.0% | 23.0% | 11.0% |
| B (07-14) | 150 | 100% | 42.0% | — | — |
| C (07-16) | 90 | 100% | 45.6% | — | — |

Offset 0 is 100 % by construction — every user is active on their install day (the seeding session sets bit 0 in the same event that establishes `first_seen`; see DD-1 in [design.md](./design.md)). Intermediate offsets 2–6, 8–29 exist in the real triangle; elided here.

**Benchmark sanity band (rough rule of thumb):** D1 ≈ 40 % / D7 ≈ 20 % / D30 ≈ 10 % (hyper-casual lower, sim/strategy higher). Cohort A's 41 / 23 / 11 sits squarely in-band — a plausibility check, not a validation rule.

---

## 3. Data needed (input)

Retention consumes **only the `session` typed event** — "active" is driven exclusively by sessions, never by generic / economy / purchase events. No retention-specific event is added. Envelope fields used, all as parts of / uses of the canonical envelope:

| Field | Meaning | Req? | Source of truth | Client/Server |
|---|---|---|---|---|
| `game_id` | Tenant | required | SDK key auth | server-stamped |
| `user_id` | Stable game-provided identity — anchors the spine row and the cohort (authoritative in v1) | required | game-provided | client (or server SDK) |
| `session_id` | Opaque per-game+user session key | required | client SDK (UUID/ULID) | client |
| `session_start_time` | Session start (skew-corrected client time); its day sets the retention bit | required | client SDK | client |
| `client_event_time` / `client_sent_time` | Feed the skew correction (Foundation §4.2) | required | client SDK | client |
| `server_received_time` | Skew-correction reference; day-seal reference | required | collector | server-stamped |
| `event_id` | 24 h dedup key (Foundation §F) — prevents a resent `session` event double-touching the bitmap | required | client SDK | client |

**Only sessions drive activeness.** A user firing generic or economy events without a `session` event emitted does **NOT** set a retention bit. (This is the locked default from §B-1: ≥1 `session` event = active.) Server SDK sessions are out of scope in v1 (server activity does not, on its own, mark a retention day).

---

## 4. Data stored for longer-run processing

**This is the story that defines the per-user spine.**

### Data-shape requirements (WHAT must be derivable — NOT how it's stored)

- **Per-user spine (minimal, durable):** per `(game_id, user_id)` — a `first_seen` timestamp (its logical-day floor = cohort + Day-0 anchor) and **the set of active day-offsets from `first_seen`**. The mechanism at the definition level: a per-user set of offsets where "set bit N" is **idempotent** — setting an already-present offset is a no-op — which is exactly what makes dedup / reprocessing / midnight-span-splits safe (FR-015 / FR-016). *(The set is realized as a per-user active-days bitmap — one bit per offset; ~4–46 bytes for D30+ coverage. That realization is a /plan storage choice; this shape requires only "the set of active day-offsets per user," not a column type.)* The set spans up to `max(retention_day_targets)` + headroom.
- **Per cohort × offset (result):** per `(game_id, cohort_date, day_offset)` a `retained_users` count; per `(game_id, cohort_date)` a `cohort_size`. Together these **are** the heatmap triangle; D1 / D7 / D30 are three columns of it.
- **Computable without raw re-scan? Yes.** Cohort assignment happens once at `first_seen`; every later `session` event needs only `first_seen` (from the spine) + the session's own start day to compute its offset and conditionally flip one bit + bump one counter. No historical event or session log is consulted. The bitmap's set-once idempotency is precisely what removes the need for return history. **Results-only constraint satisfied.**
- **Minimality justification:** the spine adds only `first_seen` + the offset set to the already-required `(game_id, user_id)`. No per-session, per-day, or per-event per-user rows are kept.

**Reused by other stories.** [003-sessions](../003-sessions/spec.md) writes this bitmap's bits; [007-derived-kpis](../007-derived-kpis/spec.md) (DAU) reprojects the same activeness by day instead of by cohort-offset; sessions' active-user-days = popcount over it.

---

## 5. Data-structure thinking — Redis & database

*Conceptual shapes only; detailed key layouts, TTLs, and durability classes are in [design.md](./design.md).*

**Redis (transient, hot).**
- **Today's cohort×offset increment counters** — the live retention tallies before they flush; transient, may be lost.
- **The 24 h dedup window** — shared; catches a resent `session` event.
- (The **bitmap itself is durable**, not a hot Redis counter — bit-setting is idempotent absolute state, so a re-flush after recovery is a no-op and a returning user stays marked.)

**Database (durable, results-only).**
- **The user spine** — `(game_id, user_id, first_seen, active_days_bitmap)`; the only per-user data kept long-term. The bitmap answers "which day-offset is this, and have we counted it?"
- **Retention results** — durable `retained_users` per game × cohort × offset, and `cohort_size` per game × cohort. The heatmap + headline read straight from here, masking immature cells at read time.

**The bridge.** Live increments flush to durable retention results on the cadence; the bitmap is updated durably (idempotent). Because the bit is absolute state (not a delta), Redis loss never double-counts on recovery.

---

## 6. Configurations

| Knob | Default | Range / values | Forward / retro |
|---|---|---|---|
| `retention_day_targets` | `[1, 7, 30]` | any set of positive offsets | **Forward-only for widening past the tracked horizon** (offsets beyond the previously-tracked max were never recorded — results-only, nothing to re-derive). Adding an offset ≤ the tracked max, or reporting narrower, is retroactive. Recommend tracking `max(targets)` + ~15 days headroom so modest widening stays retroactive; a large jump is forward-only. |
| `session_inactivity_timeout_min` | 30 | 1–240 | Owned by [003-sessions](../003-sessions/spec.md); changing it changes what qualifies as a session going forward → **forward-only**. Retention inherits, does not redefine. |
| `reporting_offset` (platform-level, Foundation §4.7) | UTC (0) | single platform offset | **Correctness-bearing, set-once at install.** Defines the platform logical day used for cohort assignment, offset math, seal, and masking. Single timezone platform-wide (no per-game / multi-timezone in v1). Changing it after data exists is a forward-rebuild (out of v1 scope), **not** a display toggle — for a single-timezone base set it to the operator's zone (e.g. Asia/Tehran +3:30) at install. |
| `retention_min_cohort_size` | 30 | integer | **Display-only** — masks mature-but-tiny cohort cells as low-confidence (sample-size guard, §2). A read-time predicate; mutates no stored cell. |

**Inherited globals:** flush 5 min, dedup 24 h, day-seal 48 h.

> Metric-sheet historical framing: an earlier `per_game_reporting_timezone_offset` display-only knob (UTC default) kept internal day-offset math in UTC to preserve the write-once immutability guarantee. The 2026-07-17 fix supersedes it with the platform-level `reporting_offset` above: the logical day is baked into the day floor rather than applied as a display-time shift, and DST / true timezone change remains a rebuild-forward that is out of v1 scope.

---

## 7. Edge cases & failure modes

- **Duplicate / resent `session` event (Foundation §F):** a resent event within the 24 h window is dropped by `event_id` dedup; even if one slips past the window, the **set-once bit** makes the re-touch a no-op (FR-016). Retention cannot double-count a returning day. This is the primary reason activeness is a *set*, not a counter.
- **Late / sealed-day events (Foundation §G / §4.3):** a `session` event whose corrected start day falls in a **sealed** day (arrived > 48 h late) is **quarantined to the raw file**, NOT folded into the sealed cohort×offset cell — the retention aggregate for a sealed day is immutable. A small offline-mobile tail is thus under-counted in a sealed cell; acceptable, recoverable only via a manual raw rebuild. This preserves classic Day-N's write-once property.
- **Clock skew (Foundation §G):** offset is computed on **skew-corrected** client start time (`+ (server_received_time − client_sent_time)`, 60 s dead-band). Sub-minute skew never crosses a day boundary except near midnight. Future-dated single events are clamped to server-now, so a fast client clock cannot invent a future cohort or offset.
- **Midnight-spanning session (sessions decision):** counted once in its **start** day; only the start-day bit set. No double-marking across the two days. Sessions' duration split never re-enters retention.
- **`first_seen` determination:** set exactly once, on the user's **first observed / accepted `session` event** (FR-015, DD-1 resolved — see [design.md](./design.md)), from its skew-corrected start day. If the very first session arrives late for an already-sealed day, the Foundation §4.3 rule applies (full stop at step 5 — the sealed-late event is never folded into any aggregate, spine bit, or catalog count); consequently such a user's cohort anchors at their next in-grace `session` event (OQ-2). *(The metric sheet's earlier note suggested `first_seen` "still records the corrected day" since spine rows are not day-sealed; the design resolves this in Foundation's favour — see OQ-2 in [design.md](./design.md).)*
- **Anon → identified (envelope / FR-004):** the **game-provided `user_id` is authoritative**; the `session` event carries whichever `user_id` is current at session end (the sessions decision keeps `session_id` stable across the transition). Anon↔user merge is **out of scope for v1** — pre-login anon activity attributed to an `anon_id` is not retro-merged into the later `user_id`'s cohort. Caveat: a user who plays anonymously then logs in may seed a spine row under `anon_id` and another under `user_id`; v1 accepts this as a known minor cohort-inflation source (documented, deferred with the merge — Foundation §4.6 / §9.3).
- **Redis loss (Foundation §E):** current-day live retention counters are transient and may be lost; sealed cohort×offset results in Postgres (flushed ≤ 5 min) and the spine survive. Because bit-setting is idempotent absolute-state (not a delta), a re-flush after recovery is a no-op — a returning user already marked stays marked. No retention double-count on recovery.

---

## 8. Open questions

Each carries a default so `/plan` isn't blocked.

- **§B-1 — Definition of "active" [LEANING → adopt].** Locked default: **≥1 `session` event** sets the offset bit (Adjust / GameAnalytics count ≥1 session). *Recommendation: keep session-based; do NOT let generic events mark activeness. An optional per-game "qualifying action" (stricter retention) is a v2 knob.*
- **§B-2 — Immature-cohort masking [LEANING → adopt].** Mask any cell where `today_logical − cohort_date < offset`; headline averages mature cohorts only (as worked above). *Recommendation: adopt as spec'd; render N/A + greyed, with a tooltip explaining "day N not yet elapsed."*
- **§B-3 — Metric labelling [LEANING → adopt].** UI labels the figure **"classic Day-N retention"** with a tooltip contrasting it with Mixpanel-style unbounded ("On or After"), and benchmarks against GameAnalytics / Adjust. *Recommendation: adopt; prevents silent comparison to a different number.*
- **§X-2 — Session definition [RESOLVED, inherited].** Locked by the sessions decision (SDK-managed, 30-min inactivity default). Retention consumes it; no further call needed here.
- **§G-2 / §G-3 — Timezone / DST [OPEN, cross-cutting].** Retention offset math is now governed by the platform logical day (Foundation §4.7); the historical guidance was "UTC-internal always, per-game reporting offset display-only and never re-buckets sealed cells." *Recommendation: a true timezone change is a rebuild-forward, out of v1 scope; document DST as display-only.*
- **OQ / target-widening horizon [OPEN].** Since offsets beyond the tracked horizon are unrecoverable (results-only), what headroom should the spine track beyond `max(retention_day_targets)`? *Recommendation: track to `max(targets)` + a small margin (e.g. +15 days) so modest widening stays retroactive; a large jump is forward-only and flagged in the UI as "tracking begins <date>."*
- **OQ / anon-identified cohort double-seed [OPEN].** A pre-login anon session then a login can create two spine rows (one per id), mildly inflating cohort counts. *Recommendation: accept as a known v1 limitation bundled with the deferred anon↔user merge; document it; revisit when merge lands.*

Design-phase open questions (OQ-1 / OQ-2 / OQ-3), including the resolved `first_seen` determination (DD-1) and the `negative_offset` enum, live in [design.md](./design.md).

---

## Cross-references

- **Depends on** [003-sessions](../003-sessions/spec.md) for the session-start activeness bit. **Owns the per-user spine** that [007-derived-kpis](../007-derived-kpis/spec.md) (DAU / new-vs-returning) and [003-sessions](../003-sessions/spec.md) (active-user-days) reuse.
- Bridge: [02.5-activeness-spine-contract](../001-analytics-platform/bridges/02.5-activeness-spine-contract.md) — the spine write-delegation contract (§5 the unified negative-offset rule, §6 the `first_seen` OQ-1 ruling).
- The deeper per-metric sheet (`first_seen` determination, anon / identified cohort double-seed, sealed-day quarantine, target-widening horizon) has been folded into this spec; its design realization is in [design.md](./design.md).
