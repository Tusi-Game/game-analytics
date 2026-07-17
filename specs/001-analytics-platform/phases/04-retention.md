# Phase 04 — Retention (Classic Day-N)

**Feature**: 001-analytics-platform · **Story**: US3 (P2) · **Reserved kind**: consumes `session` (owns none) · **Status**: Draft
**Depends on**: Phase 01 (ingest), **Phase 02 (sessions — activeness anchor; the session-start bit is retention's only input)**.
**Deeper reference**: [`../metrics/03-retention.md`](../metrics/03-retention.md). **Spec**: US3, FR-015/016/017.
**Excluded here** (→ later per-phase design): bitmap storage realization, key layouts, DDL.

---

## 1. Story understanding

**The story.** The developer sees how many players return on day 1, day 7, and day 30 after their first session — each as a percentage of that install-date cohort.

**The question it answers.** *Of the players who first appeared on a given calendar day (an install-date cohort), what fraction were still active exactly N days later?* Retention is the headline health metric — D1 caps everything downstream — and it is the metric that drove the "minimal per-user spine" storage decision.

**Definition (LOCKED — classic Nth-day / "On" retention):**
> `D_N = retained_users(offset = N) / cohort_size`, grouped by install-date cohort, where a user counts toward `offset = N` iff they were **active on the day exactly N days after their `first_seen` day** (UTC). Independent per offset; stable and write-once once day N has elapsed.

The dashboard MUST label this **"classic Day-N retention."**

**Rejected variants.** *Range/bracket* (active on day N or later within a bracket — more forgiving, not the reference metric) and *rolling/unbounded* (Mixpanel's "On or After" — **disqualified by results-only storage**: its per-cell test `max(active_offsets) ≥ N` depends on a *future* maximum, so a late return retroactively bumps earlier cells → requires rewriting sealed cells or per-user return history, both forbidden). Classic's test is `N ∈ active_offsets` — idempotent, order-independent, write-once. This is the load-bearing reason for the choice.

**What it means for the operator.** A retention curve and the full cohort heatmap triangle from a spine of a few small columns per user — no raw event history.

---

## 2. How it is calculated

**Grain / bucketing.**
- **Cohort** = `date_utc(first_seen)`, per `game_id`.
- **Day-offset** = `date_utc(session_start_time) − date_utc(first_seen)`, on skew-corrected UTC time. Offset 0 = install day.
- **Bit-set rule (idempotent):** for each qualifying `session` event, if the user's bit for `offset` is unset, set it and increment `retained_users(game, cohort, offset)`. Setting an already-set bit is a **no-op** — this makes reprocessing, dedup-misses, and midnight-span-splits safe (FR-016).
- A midnight-spanning session counts once, in its **start** day (only that bit set).

**Formulas:**
```
cohort_size(g, c)       = # distinct users with date_utc(first_seen) = c   (game g)
retained_users(g, c, N) = # users in cohort (g,c) whose active-offset set contains N
D_N(g, c)               = retained_users(g, c, N) / cohort_size(g, c)
headline D_N(g)         = Σ_c retained_users(g,c,N) / Σ_c cohort_size(g,c)   over mature cohorts only
```
D1/D7/D30 are columns N = 1/7/30 of the same table; the cohort × offset triangle **is** the heatmap.

**Immature-cohort masking:** mask (render **N/A**, never a low number) any cell where `today_utc − cohort_date < N` (day N not yet elapsed). Headline averages **mature cohorts only** — a cohort installed 3 days ago must not drag D7/D30 toward zero.

### Worked example (today = 2026-07-17 UTC)

**Cohort A — 2026-06-01** (46 days elapsed), size 200: offset1 = 82 → **D1 41.0%**; offset7 = 46 → **D7 23.0%**; offset30 = 22 → **D30 11.0%**.
**Cohort B — 2026-07-14** (3 days), size 150: offset1 = 63 → **D1 42.0%**; D7, D30 → **N/A (masked)**.
**Cohort C — 2026-07-16** (1 day), size 90: offset1 = 41 → **D1 45.6%**; D7, D30 → **N/A**.

**Headline (mature only):**
- D1 = (82+63+41)/(200+150+90) = 186/440 = **42.3%**
- D7 = 46/200 = **23.0%** (only A mature at offset 7)
- D30 = 22/200 = **11.0%** (only A mature at offset 30)

Without masking, D7 would falsely read 46/440 = 10.5% because 290 users hadn't had the chance to reach day 7.

**Heatmap triangle** (`—` = masked):

| Cohort | size | off 0 | off 1 | off 7 | off 30 |
|---|---|---|---|---|---|
| A (06-01) | 200 | 100% | 41.0% | 23.0% | 11.0% |
| B (07-14) | 150 | 100% | 42.0% | — | — |
| C (07-16) | 90 | 100% | 45.6% | — | — |

Benchmark sanity band: D1 ≈ 40% / D7 ≈ 20% / D30 ≈ 10% — Cohort A sits in-band (plausibility check, not a validation rule).

---

## 3. Data needed (input)

Retention consumes **only the `session` typed event** — "active" is driven exclusively by sessions, never by generic/economy/purchase events. Envelope fields used:

| Field | Meaning |
|---|---|
| `game_id` | Tenant. |
| `user_id` | Stable game-provided identity — anchors the spine row and the cohort (authoritative in v1). |
| `session_id` | Opaque per-game+user key. |
| `session_start_time` | Its **UTC day** sets the retention bit. |
| `client_event_time` / `client_sent_time` / `server_received_time` | Feed skew-correction and the day-seal reference. |
| `event_id` | 24 h dedup — prevents a resent `session` event double-touching the bitmap. |

**Only sessions drive activeness.** A user firing generic/economy events without a `session` event does **not** set a retention bit. Server SDK sessions are out of scope in v1 (server activity does not, on its own, mark a retention day).

---

## 4. Data stored for longer-run processing

**This is the phase that defines the per-user spine.**

- **Per-user spine (minimal, durable):** per `(game_id, user_id)` — a `first_seen` timestamp (its UTC day = cohort + Day-0 anchor) and **the set of active day-offsets from `first_seen`**, realized as a per-user **active-days bitmap** (one bit per offset; ~4–46 bytes for D30+ coverage). "Set bit N" is **idempotent** — the property that removes the need for return history. The set spans up to `max(retention_day_targets)` + headroom.
- **Per cohort × offset (result):** per `(game_id, cohort_date, day_offset)` a `retained_users` count; per `(game_id, cohort_date)` a `cohort_size`. Together these **are** the heatmap triangle.

**Reused by other phases.** Phase 02 (sessions) writes this bitmap's bits; Phase 06 (DAU) reprojects the same activeness by day instead of by cohort-offset; Phase 02's active-user-days = popcount over it. No per-session/per-day/per-event per-user rows are kept.

Computable without raw re-scan? **Yes** — cohort assignment happens once at `first_seen`; every later session needs only `first_seen` (from the spine) + its own UTC start day to compute an offset and conditionally flip one bit + bump one counter. The set-once idempotency is precisely what removes return history. **Results-only satisfied.**

---

## 5. Data-structure thinking — Redis & database

*Conceptual shapes only.*

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
| `retention_day_targets` | `[1, 7, 30]` | any set of positive offsets | **Forward-only for widening past the tracked horizon** (offsets beyond the previously-tracked max were never recorded — results-only, nothing to re-derive). Adding an offset ≤ the tracked max, or reporting narrower, is retroactive. Recommend tracking `max(targets)` + ~15 days headroom so modest widening stays retroactive. |
| `session_inactivity_timeout_min` | 30 | 1–240 | Owned by Phase 02; changing it changes what qualifies as a session going forward → **forward-only**. Retention inherits, does not redefine. |
| `per_game_reporting_timezone_offset` | UTC | display offset | **Display-only, never re-buckets** — offset math stays UTC to preserve write-once immutability. A true timezone re-bucket is a rebuild-forward, out of v1 scope. |

**Inherited globals:** flush 5 min, dedup 24 h, day-seal 48 h.

---

## Cross-references

- Deeper sheet: [`../metrics/03-retention.md`](../metrics/03-retention.md) — `first_seen` determination, anon/identified cohort double-seed, sealed-day quarantine, target-widening horizon, all open questions.
- **Depends on Phase 02** for the session-start activeness bit. **Owns the per-user spine** that Phase 06 (DAU / new-vs-returning) and Phase 02 (active-user-days) reuse.
