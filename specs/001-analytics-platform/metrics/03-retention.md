# Metric Spec Sheet: Retention (Classic Day-N)

**Feature**: 001-analytics-platform · **Phase**: research/specify · **Status**: Draft
**Depends on**: §B (retention decision), §G (event-time/UTC day), SESSIONS DECISION (§X-2, now locked), §F (dedup); User spine + Retention result entities in `spec.md`; US3 / FR-015 / FR-016 / FR-017.

## 1. Purpose & Definition

Retention answers: **of the players who first appeared on a given calendar day (an install-date cohort), what fraction were still active exactly N days later?** It is the headline health metric — D1 caps everything downstream — and it is the metric that drove the "minimal per-user spine" storage decision.

**Definition (LOCKED — classic Nth-day / "On" retention, per §B):**

> `D_N = retained_users(offset = N) / cohort_size`, grouped by install-date cohort, where a user counts toward `offset = N` iff they were **active on the day exactly N days after their `first_seen` day** (UTC). Independent per offset; stable and write-once once day N of a cohort has elapsed.

The dashboard MUST label this **"classic Day-N retention"** (§B-3).

**Rejected variants (§B):**
- **Range / bracket retention** (active on day N *or later within a bracket*) — more forgiving, higher numbers; not the reference metric.
- **Rolling / unbounded retention** (active on day N *or any later day*; Mixpanel's "On or After" default) — **disqualified by results-only storage.** Rolling's per-cell test is `max(active_offsets) ≥ N`, which depends on a *future* maximum: a late return retroactively bumps *earlier* day-N cells. That requires retroactively rewriting already-sealed heatmap cells, which is impossible without per-user return history or a raw event re-scan — both forbidden in v1. Classic's test is `N ∈ active_offsets` — idempotent, order-independent, and write-once. This is the load-bearing reason for the choice: it is the only definition computable from incremental results + a minimal spine.

## 2. SDK Data Captured

Retention consumes only the reserved **`session`** typed event (per the SESSIONS DECISION). No retention-specific event is added; "active" is driven **exclusively by sessions** — never by generic/economy/purchase events. Fields used, all as parts of / uses of the canonical envelope:

| Field | Meaning | Req? | Source of truth | Client/Server |
|---|---|---|---|---|
| `game_id` | Tenant | required | SDK key auth | server-stamped |
| `user_id` | Stable game-provided identity; anchors the spine row and the cohort | required | game-provided (authoritative in v1) | client (or server SDK) |
| `session_id` | Opaque per-game+user session key | required | client SDK (UUID/ULID) | client |
| `session_start_time` | Session start (skew-corrected client time); its **UTC day** sets the retention bit | required | client SDK | client |
| `client_event_time` / `client_sent_time` | Feed the §G skew correction | required | client SDK | client |
| `server_received_time` | Skew-correction reference; day-seal reference | required | collector | server-stamped |
| `event_id` | 24h dedup key (§F) — prevents a resent `session` event double-touching the bitmap | required | client SDK | client |

**Trust boundary:** retention is a **client-behavior** metric (players return by playing), so the client `session` event is the accepted source; there is no money/economy trust concern here. Server SDK sessions are out of scope in v1 (server events inherit a passed-in `session_id` or none), so server-side activity does not, on its own, mark a retention day.

**Only sessions drive activeness.** A user firing generic or economy events without a `session` event emitted does NOT set a retention bit. (See Open Question §B-1 — this is the locked default: ≥1 `session` event = active.)

## 3. Admin Configuration

| Knob | Default | Range / values | Retroactive or forward? |
|---|---|---|---|
| `retention_day_targets` | `[1, 7, 30]` | any set of positive integer offsets; sets the reported/headline offsets and the widest offset the spine must cover | **Forward-only for widening past the previously-covered offset** (a newly-added larger offset — e.g. D60 — cannot be back-filled for cohorts whose spine only tracked up to the old max, since per-user return history beyond the tracked window is not retained). Reporting *narrower* offsets already covered is a display change and applies retroactively. Adding an offset ≤ the already-tracked max is retroactive. |
| `session_inactivity_timeout_min` | 30 | 1–240 | Owned by the SESSIONS sheet; changing it changes what qualifies as a session going forward → **forward-only** (past sessions already sealed). Retention inherits this; does not re-define it. |
| `per_game_reporting_timezone_offset` | UTC (0) | display offset | **Display-only, never re-buckets** (§G-2/§G-3). Internal day-offset math stays UTC to preserve the §B write-once immutability guarantee. A true timezone re-bucket would require a rebuild-forward and is out of v1 scope. |

**Justification for the forward-only default on widening targets:** the spine tracks the *set of active day-offsets up to the widest reported offset*. Offsets beyond that horizon were never recorded (nothing to re-derive from — results-only, no raw re-scan). Recommend defaulting the tracked horizon to `max(retention_day_targets)` plus a small headroom margin so a modest widening (e.g. 30 → 45) stays retroactive; a large jump is forward-only.

## 4. Calculation

**Grain / bucketing (explicit):**
- **Cohort grain:** install-date cohort = `date_utc(first_seen)`, per `game_id`.
- **Day-offset:** `offset = date_utc(session_start_time) − date_utc(first_seen)`, computed on **skew-corrected client-event-time, UTC** (§G). Offset 0 = install day.
- **Bit-set rule (idempotent):** for each qualifying `session` event, if the user's bit for `offset` is unset, set it and increment `retained_users(game_id, cohort_date, offset)`. Setting an already-set bit is a no-op — this is what makes reprocessing, dedup misses, and midnight-spanning sessions safe (FR-016).
- A session that **spans UTC midnight** counts once, in its **start day** (per SESSIONS DECISION): only the start day's bit is set. Duration may be split pro-rata for other metrics, but retention uses start-day only.

**Formulas (definitional):**
```
cohort_size(g, c)            = # distinct users with date_utc(first_seen) = c   (in game g)
retained_users(g, c, N)      = # users in cohort (g,c) whose active-offset set contains N
D_N(g, c)                    = retained_users(g, c, N) / cohort_size(g, c)
headline D_N(g)              = Σ_c retained_users(g, c, N) / Σ_c cohort_size(g, c)   over mature cohorts only
```
D1 / D7 / D30 are simply `N = 1 / 7 / 30` of the same table. The full **cohort × day-offset triangle** IS the heatmap; the headline curve is three columns of it. Same definition drives headline and heatmap automatically.

**Immature-cohort masking (§B-2):** a cohort's day-N cell is only meaningful once day N has fully elapsed. Mask (render **N/A**, never a low number) any cell where:
```
today_utc − cohort_date < N        →  masked (day N not yet elapsed)
```
Headline D_N averages over **mature cohorts only** — a cohort installed 3 days ago must not drag D7/D30 toward zero.

### Worked numeric example

Game `g`. Reporting "today" = **2026-07-17 (UTC)**. Three cohorts:

**Cohort A — install date 2026-06-01** (46 days elapsed, so D1/D7/D30 all mature). `cohort_size = 200`.
Active-offset tallies (users whose bit is set at that offset):
- offset 1: 82 users → **D1 = 82/200 = 41.0%**
- offset 7: 46 users → **D7 = 46/200 = 23.0%**
- offset 30: 22 users → **D30 = 22/200 = 11.0%**

**Cohort B — install date 2026-07-14** (3 days elapsed). `cohort_size = 150`.
- offset 1: 63 users → **D1 = 63/150 = 42.0%** (day 1 elapsed → mature)
- offset 7: `today − cohort = 3 < 7` → **D7 = N/A (masked)**
- offset 30: `3 < 30` → **D30 = N/A (masked)**

**Cohort C — install date 2026-07-16** (1 day elapsed). `cohort_size = 90`.
- offset 1: `today − cohort = 1`, so day 1 has *just* elapsed → mature. 41 users → **D1 = 41/90 = 45.6%**
- offset 7, 30 → **N/A (masked)**

**Headline (mature cohorts only):**
- Headline D1 = (82+63+41) / (200+150+90) = 186 / 440 = **42.3%** (all three cohorts have an elapsed day 1)
- Headline D7 = 46 / 200 = **23.0%** (only Cohort A is mature at offset 7)
- Headline D30 = 22 / 200 = **11.0%** (only Cohort A is mature at offset 30)

Note how B and C contribute to D1 but are *excluded* from D7/D30 — without masking, D7 would falsely read `46/440 = 10.5%` because 290 users hadn't had the chance to reach day 7.

**Heatmap triangle** (rows = cohort, cols = offset; `—` = masked/not-yet-elapsed):

| Cohort | size | off 0 | off 1 | off 7 | off 30 |
|---|---|---|---|---|---|
| A (06-01) | 200 | 100% | 41.0% | 23.0% | 11.0% |
| B (07-14) | 150 | 100% | 42.0% | — | — |
| C (07-16) | 90 | 100% | 45.6% | — | — |

(Offset 0 is 100% by construction — every user is active on their install day. Intermediate offsets 2–6, 8–29 exist in the real triangle; elided here.)

**Benchmark sanity band (§B-3, rough rule of thumb):** D1 ≈ 40% / D7 ≈ 20% / D30 ≈ 10% (hyper-casual lower, sim/strategy higher). Cohort A's 41 / 23 / 11 sits squarely in-band — a plausibility check, not a validation rule.

## 5. Data-Shape Requirements (WHAT must be derivable — NOT how it's stored)

- **Per user (minimal spine):** we must maintain, per `(game_id, user_id)`, a `first_seen` timestamp (its UTC day is the cohort + Day-0 anchor) and **the set of active day-offsets from `first_seen`**. The mechanism at the definition level: a per-user set of offsets where "set bit N" is **idempotent** — setting an already-present offset is a no-op — which is exactly what makes dedup/reprocessing/midnight-span-splits safe (FR-015/FR-016). *(The set is realized as a per-user active-days bitmap; that realization is a /plan storage choice — this sheet requires only "the set of active day-offsets per user," not a column type.)* The set need only span up to `max(retention_day_targets)` (+ headroom).
- **Per cohort × offset (result):** per `(game_id, cohort_date, day_offset)`, we must be able to produce `retained_users` (count); and per `(game_id, cohort_date)`, `cohort_size`. Together these ARE the heatmap triangle; D1/D7/D30 are three columns of it.
- **Computable without raw re-scan?** **Yes.** Cohort assignment happens once at `first_seen`; every later `session` event needs only `first_seen` (from the spine) + the session's own UTC start day to compute its offset and conditionally flip one bit + bump one counter. No historical event or session log is consulted. The bitmap's set-once idempotency is precisely what removes the need for return history. **Results-only constraint satisfied.**
- **Minimality justification:** the spine adds only `first_seen` + the offset set to the already-required `(game_id, user_id)`. No per-session, per-day, or per-event per-user rows are kept.

## 6. Edge Cases & Failure Modes

- **Duplicate / resent `session` event (§F):** a resent event within the 24h window is dropped by `event_id` dedup; even if one slips past the window, the **set-once bit** makes the re-touch a no-op (FR-016). Retention cannot double-count a returning day. This is the primary reason activeness is a *set*, not a counter.
- **Late / sealed-day events (§G):** a `session` event whose corrected start day falls in a **sealed** day (arrived >48h late) is **quarantined to the raw file**, NOT folded into the sealed cohort×offset cell — the retention aggregate for a sealed day is immutable. A small offline-mobile tail is thus under-counted in a sealed cell; acceptable, recoverable only via a manual raw rebuild (§X-1). This preserves classic Day-N's write-once property.
- **Clock skew (§G):** offset is computed on **skew-corrected** client start time (`+ (server_received_time − client_sent_time)`, 60s dead-band). Sub-minute skew never crosses a day boundary except near midnight. Future-dated single events are clamped to server-now, so a fast client clock cannot invent a future cohort or offset.
- **Midnight-spanning session (SESSIONS DECISION):** counted once in its **start** UTC day; only the start-day bit set. No double-marking across the two days.
- **`first_seen` determination:** set exactly once, on the user's **first observed `session` event** (FR-015), from its skew-corrected UTC start day. If the very first session arrives late for an already-sealed day, `first_seen` still records the corrected day (spine rows are not day-sealed the way aggregates are); the cohort it lands in may already be sealed for aggregation, in which case the increment is quarantined per §G — flag as an Open Question if operators want first-session lateness handled specially.
- **Anon → identified (§ envelope / FR-004):** the **game-provided `user_id` is authoritative**; the `session` event carries whichever `user_id` is current at session end (SESSIONS DECISION keeps `session_id` stable across the transition). Anon↔user merge is **out of scope for v1** — pre-login anon activity attributed to an `anon_id` is not retro-merged into the later `user_id`'s cohort. Caveat: a user who plays anonymously then logs in may seed a spine row under `anon_id` and another under `user_id`; v1 accepts this as a known minor cohort-inflation source (documented, deferred with the merge).
- **Redis loss (§E):** current-day live retention counters are transient and may be lost; sealed cohort×offset results in Postgres (flushed ≤5 min) and the spine survive. Because bit-setting is idempotent absolute-state (not a delta), a re-flush after recovery is a no-op — a returning user already marked stays marked. No retention double-count on recovery.

## 7. Open Questions

Pulled from `research.md §6` (§B family + dependencies), each with a default so `/plan` isn't blocked:

- **§B-1 — Definition of "active" [LEANING → adopt].** Locked default: **≥1 `session` event** sets the offset bit (Adjust/GameAnalytics count ≥1 session). *Recommendation: keep session-based; do NOT let generic events mark activeness. An optional per-game "qualifying action" (stricter retention) is a v2 knob.*
- **§B-2 — Immature-cohort masking [LEANING → adopt].** Mask any cell where `today_utc − cohort_date < offset`; headline averages mature cohorts only (as worked above). *Recommendation: adopt as spec'd; render N/A + greyed, with a tooltip explaining "day N not yet elapsed."*
- **§B-3 — Metric labelling [LEANING → adopt].** UI labels the figure **"classic Day-N retention"** with a tooltip contrasting it with Mixpanel-style unbounded ("On or After"), and benchmarks against GameAnalytics/Adjust. *Recommendation: adopt; prevents silent comparison to a different number.*
- **§X-2 — Session definition [RESOLVED, inherited].** Now locked by the SESSIONS DECISION (SDK-managed, 30-min inactivity default). Retention consumes it; no further call needed here.
- **§G-2 / §G-3 — Timezone/DST [OPEN, cross-cutting].** Retention offset math MUST stay UTC internally; per-game reporting offset is display-only and never re-buckets sealed cells (else it breaks §B immutability). *Recommendation: UTC-internal always; a true timezone change is a rebuild-forward, out of v1 scope; document DST as display-only.*
- **NEW — Retention-target widening horizon [OPEN].** Since offsets beyond the tracked horizon are unrecoverable (results-only), what headroom should the spine track beyond `max(retention_day_targets)`? *Recommendation: track to `max(targets)` + a small margin (e.g. +15 days) so modest widening stays retroactive; a large jump is forward-only and flagged in the UI as "tracking begins <date>."*
- **NEW — Anon/identified cohort double-seed [OPEN].** A pre-login anon session then a login can create two spine rows (one per id), mildly inflating cohort counts. *Recommendation: accept as a known v1 limitation bundled with the deferred anon↔user merge; document it; revisit when merge lands.*
