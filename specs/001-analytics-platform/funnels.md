# Metric Spec Sheet: Funnels

**Feature**: 001-analytics-platform · **Phase**: research/specify · **Status**: Draft
**Depends on**: §G (event-time / skew-correction / 48h day-seal), §B (retention spine mechanism — the per-user bitmap precedent), §H (schema: step events are free-form named or reserved-typed; property filters read the prop bag), SESSIONS decision (conversion-window clock uses skew-corrected client-event-time), FR-022 (single-per-game funnel design), research §C (funnel domain knowledge)

---

## 1. Purpose & Definition

**Question answered**: "Of the users who entered an intended path (step A), how many progressed through the ordered steps (B, C, …) within a bounded time, and where did they drop off?" A funnel measures ordered multi-step conversion and localizes the largest leak in a designed sequence (tutorial → first-match → first-purchase, or onboarding → level-3 → retention hook).

**Definition (chosen for v1)**: A funnel is an **ordered list of steps** — each step is an *event name* plus optional *property-filter predicate* — together with a **conversion window** (max elapsed wall-clock time, on skew-corrected client-event-time per §G, from the user's Step-1 entry to the step being counted) and an **ordering mode**. A user *reaches step k* iff they emitted a matching event for every step 1..k in an order permitted by the ordering mode, each at or after the prior matching step, and step k's matching event falls within the conversion window measured from their Step-1 entry.

- **Ordering mode — v1 default: `sequential-with-others-allowed`** (a.k.a. "ordered, non-strict"). Steps must occur in the defined order, but unrelated events may interleave. This is the PostHog/industry default and matches real player behavior (players do other things between funnel milestones). *Rejected for v1 default*: **strict** (step k's event must be the *immediately next* event after step k−1 — brittle, almost never what a game designer means, requires the full local event sequence to verify); **any-order** (steps in any order — this is a set-membership check, not a funnel, and discards the drop-off ordering that is the whole point). Both remain config-selectable (see §3) but the recommended and default mode is `sequential-with-others-allowed`.
- **Attribution — v1 default: `first-touch`**. A user's Step-1 entry is anchored on their **first** matching Step-1 event; the conversion window and progression are measured from that first touch. *Rejected*: `any-touch` (re-anchor on every Step-1 recurrence and take the best completing window) — this requires retaining a user's Step-1 event *history* to re-evaluate overlapping windows, which the results-only spine cannot hold without raw re-scan. First-touch needs only the single earliest Step-1 timestamp per user. `any-touch` is deferred (Open Question §OQ-4).

**SCOPE NOTE — DECLINED for v1 (resolved 2026-07-17).** The scope promotion proposed by this sheet was declined. FR-022 stands: v1 designs the data model for one funnel per game but ships no funnel ingestion, computation, or UI. This sheet remains as a **forward-compatible specification artifact** — the calculation, config model, and data-shape requirements are correct and ready for v2. The per-participant progress spine (§5) is not required in v1; pruning it from the spine-budget ledger (metrics/README.md) saves the single largest per-user draw.

---

## 2. SDK Data Captured

Funnels introduce **no new event kind**. A funnel step matches events the SDK already sends under the canonical envelope — a step's event may be a free-form named event (§H accept-all) or a reserved typed kind (`economy`/`purchase`/`session`). The metric is computed from events already in flight; the SDK's only obligation is that step-defining events and their filter properties are actually emitted.

| Field | Meaning | Req/Opt | Source of truth |
|---|---|---|---|
| `name` (envelope) | Matched against each step's configured event name. | required | client SDK (or server SDK for server-authoritative steps, e.g. a `purchase` final step) |
| `props.*` (envelope) | Read by a step's optional property-filter predicate (e.g. `props.level >= 3`). | optional | whichever SDK emits the step event; **client props are spoofable** — if a funnel's final step is a `purchase`, that step matches the **server** purchase row (§D truth boundary), not the client companion event |
| `client_event_time` (envelope) | Per-event; the ordering + conversion-window clock, after §G skew-correction. | required | client SDK |
| `client_sent_time` / `server_received_time` (envelope) | Feed §G skew-correction so the conversion-window measurement uses `corrected` time. | required | client SDK / collector |
| `user_id` (envelope) | The funnel is per-user; progression state is keyed by user. Anon→user merge out of scope (§v1) — a user who advances steps while anon then logs in may split across two user_ids. | required | game-provided |

**Trust boundary**: for a funnel whose steps are all generic/economy client events, the whole funnel is client-trust (acceptable — funnels are behavioral, not money-truth). For a funnel with a `purchase` step, that step MUST resolve against the **server-verified** purchase (§D), never the client's zero-money context-companion event; otherwise a spoofed client could fake conversions. No new fields are required beyond the envelope.

---

## 3. Admin Configuration

All funnel config lives on the **Game (tenant)** config as the single per-game funnel definition (FR-022 forward-compat: exactly one funnel per game in v1).

| Knob | Default | Allowed range/values | Retro vs Forward |
|---|---|---|---|
| `funnel.enabled` | `false` | bool | Forward-only (enabling starts progress capture from that moment; no backfill — see below) |
| `funnel.steps[]` | (none) | ordered list, **2–8 steps**; each = `{ event_name, filters? }` | **Forward-only** (see "why forward-only" below) |
| `funnel.steps[].event_name` | — | any registered/accepted event name (§H catalog) or reserved kind | Forward-only |
| `funnel.steps[].filters` | none | property predicates over `props.*` (equality / range); ANDed | Forward-only |
| `funnel.conversion_window` | **7 days** | `1h`–`30d` | Forward-only |
| `funnel.ordering_mode` | `sequential-with-others-allowed` | `sequential-with-others-allowed` \| `strict` \| `any-order` | Forward-only |
| `funnel.attribution` | `first-touch` | `first-touch` \| `any-touch`(deferred, §OQ-4) | Forward-only |
| `funnel.segment_dimensions` | none | subset of already-captured context dims (e.g. `region`, `level_bucket`, `install_cohort`) | Forward-only |

**Why every funnel-definition change is FORWARD-ONLY (hard constraint, not a default).** You **cannot** recompute a `sequential-with-others-allowed` funnel over sealed data without raw events. Recomputation asks "for each historical user, did their ordered event stream satisfy the new step list / new window / new order mode?" — that is precisely the per-user sequential path question, and the per-user path is exactly what results-only storage does not keep (raw is gone: quarantined/sealed per §G, uploaded-then-deleted per US5). The maintained funnel-progress state (§5) is *specific to the funnel definition in force when it was written* — it records "furthest step reached under THESE steps," so it is meaningless against a different step list. Therefore: **redefining a funnel resets progress capture; results before the change reflect the old definition, results after reflect the new one, and the two do not compose.** This mirrors the monetization "rebuild-forward on dimension change" posture (FR-020) and the §G/§G-3 immutability rule. The dashboard MUST show the definition-version boundary so old and new funnel numbers are never silently concatenated.

**No backfill on enable**: turning `funnel.enabled` on cannot retroactively reconstruct who was mid-path yesterday (no raw). The funnel reports only cohorts whose Step-1 entry occurred at/after enablement. Pre-enable users are invisible to the funnel (not counted as drop-off).

---

## 4. Calculation

**Time-bucketing & grain**: progression is measured on **skew-corrected client-event-time (UTC)** per §G. A user is assigned to a **funnel cohort by the UTC day of their Step-1 entry** (first-touch anchor). The conversion window is wall-clock elapsed time from that Step-1 entry, independent of UTC-day boundaries (a window may span days). Segment grain = per-game × (optional configured `segment_dimensions`, evaluated from the Step-1 entry event's context, frozen at entry).

**Definitional formulas** — for a funnel with steps 1..K, over a chosen reporting cohort set (e.g. Step-1 entries in a date range):

- **Step-k reached count** `R_k` = number of users who reached step k (satisfied steps 1..k in-order, in-window). Note `R_1 ≥ R_2 ≥ … ≥ R_K` (monotone non-increasing — reaching k implies reaching all j<k).
- **Step-to-step conversion** `C_k = R_k / R_{k−1}` for k≥2 (fraction of step-(k−1) reachers who advanced to k).
- **Overall conversion** `Overall = R_K / R_1` (equivalently `∏_{k=2..K} C_k`).
- **Step-k drop-off** `D_k = R_{k−1} − R_k` (absolute), `d_k = 1 − C_k = D_k / R_{k−1}` (rate). Where the largest `D_k` sits is the leak to fix.
- **Time-to-convert** at step k = distribution of (`corrected_time` of the step-k match − `corrected_time` of Step-1 entry) over users who reached k; report **median** (and p90 optional). A separate **overall time-to-convert** = that delta at step K, over users who fully converted.
- **Immature / partial-window handling**: a Step-1 cohort whose conversion window has **not fully elapsed** (`now − cohort_step1_time < conversion_window`) is **in-flight** — later steps may still land. Its `R_{k>1}` and conversion rates MUST be rendered **provisional / masked**, never as a final low number (same discipline as §B-2 immature-cohort masking). Only cohorts whose window has fully closed produce final figures. (This is the sealed-boundary interaction — see §6.)

**Worked numeric example.** Funnel `Onboard→Buy`, `sequential-with-others-allowed`, first-touch, conversion window = 48h. Steps:
1. `tutorial_complete`
2. `match_played` (filter: `props.mode == "ranked"`)
3. `store_opened`
4. `purchase` (server-verified; filter `environment == prod`)

Cohort: **1,000 users** whose first `tutorial_complete` (Step-1 entry) landed on UTC day 2026-07-10 (window closed — mature).

Observed furthest-step-reached tallies (each user counted at their max step, all within their 48h window):

| Furthest step reached | Users |
|---|---|
| Only step 1 | 300 |
| Reached step 2 (not 3) | 250 |
| Reached step 3 (not 4) | 200 |
| Reached step 4 (converted) | 250 |

Cumulative **reached counts** (monotone):
- `R_1` = 1000
- `R_2` = 1000 − 300 = **700**
- `R_3` = 700 − 250 = **450**
- `R_4` = 450 − 200 = **250**

**Step-to-step conversion**:
- `C_2 = R_2/R_1 = 700/1000 = 70.0%`
- `C_3 = R_3/R_2 = 450/700 = 64.3%`
- `C_4 = R_4/R_3 = 250/450 = 55.6%`

**Overall conversion**: `R_4/R_1 = 250/1000 = 25.0%` (check: `0.70 × 0.643 × 0.556 = 0.250` ✓).

**Drop-off** (absolute / rate):
- Step 1→2: `D_2 = 300`, `d_2 = 30.0%`
- Step 2→3: `D_3 = 250`, `d_3 = 35.7%` ← **largest leak** (ranked-match after tutorial); the actionable finding
- Step 3→4: `D_4 = 200`, `d_4 = 44.4%` by rate (largest *rate*, smaller absolute) — report both; absolute counts users, rate counts leakiness

**Time-to-convert** (median deltas from Step-1 entry, over reachers of that step): step 2 median 20 min; step 3 median 3.5 h; step 4 (overall convert) median 26 h. Interpretation: converters take just over a day, comfortably inside the 48h window.

**Breakable by segment**: with `segment_dimensions = [region]`, the same tallies split by the Step-1 entry event's `region` — e.g. `Overall(region=EU) = 40/220 = 18.2%` vs `Overall(region=US) = 150/500 = 30.0%` — each segment carrying its own `R_k` vector, computed identically. Segment is frozen at Step-1 entry (a user who changes region mid-window stays in their entry segment) to keep the state additive.

---

## 5. Data-Shape Requirements (WHAT must be derivable — NOT how it's stored)

**This is the key finding of the sheet.** A funnel cannot be reduced to a pure per-cohort result counter the way economy or classic retention can, because the drop-off question is *per-user and order-dependent*. To compute it **without re-scanning raw events**, the platform must maintain a small, fixed **per-user funnel-progress state**, updated incrementally as events arrive.

**Per-user-per-funnel progress state (the minimal spine expansion).** For each user who has entered the funnel (emitted a Step-1 match), maintain, keyed by `(game_id, user_id, funnel_definition_version)`:
- **`furthest_step_reached`** — the highest step index k satisfied so far under the ordering mode (a small integer, 1..K).
- **`step1_entry_time`** — the skew-corrected UTC timestamp of the first-touch Step-1 entry (anchors the conversion window and the cohort day). Written once, immutable (first-touch).
- **`last_advanced_time`** (optional but recommended) — corrected timestamp of the event that set `furthest_step_reached`, to derive time-to-convert without keeping intermediate step timestamps. If per-step time-to-convert medians for *every* step are required, this must instead be **per-reached-step entry timestamps** (K small timestamps) — a bounded, fixed-size vector, still no raw log. v1 default: keep only `step1_entry_time` + `last_advanced_time` (overall + furthest-step timing); full per-step timing is Open Question §OQ-3.
- **`segment_key`** (if `segment_dimensions` configured) — the frozen segment values captured at Step-1 entry.

**Incremental update rule** (as each event arrives, no re-scan): if the event matches step `furthest_step_reached + 1`'s predicate **and** falls within `[step1_entry_time, step1_entry_time + conversion_window]` **and** ordering-mode constraints hold, advance `furthest_step_reached` by 1 (and stamp `last_advanced_time`). Under `sequential-with-others-allowed`, "ordering holds" reduces to "the event's corrected time ≥ the time step k−1 was reached" — which the maintained state already knows, so **no local event history is needed**. This is what makes the default mode computable from fixed per-user state; `strict` mode would additionally need "was this the *immediately* next event," which requires the adjacent event and is a reason to keep `strict` off the default path (Open Question §OQ-2).

**Result shape (the reportable rollup, derivable from the spine).** Per `(game_id, funnel_definition_version, step1_cohort_day, segment_key)` we must be able to produce the **furthest-step-reached histogram** — a fixed K-bucket vector (count of users whose max step = 1, = 2, …, = K). Every §4 figure (`R_k`, `C_k`, `Overall`, `D_k`) is a running-sum reduction of that histogram; it is a small per-cohort result, not per-user, once sealed. Time-to-convert needs the per-user timing fields above reduced to a median/percentile per cohort.

**Minimality / justification.** The state is **fixed and tiny per active funnel-participant**: one small integer + 1–2 timestamps (+ optional bounded segment key), one record per user who entered the *single* per-game funnel. It is the funnel analogue of §B's per-user active-days bitmap — the smallest per-user state that makes an inherently per-user metric idempotent and re-scan-free. It is idempotent under duplicate/reordered delivery: advancement is monotone (`furthest_step_reached` only rises) and gated by the fixed `step1_entry_time` window, so a replayed event never regresses or double-advances.

**Computable WITHOUT raw re-scan? — YES, but only forward, and only by paying this per-user-state cost.** Confirmed: with the progress state maintained incrementally, no historical figure ever requires reading a raw event. **The honest cost, flagged loudly**: this **expands the durable per-user spine** beyond retention's bitmap by adding one progress record per funnel participant. That **trades against SC-007** (spine stays a handful of small columns). It is bounded — one funnel per game, a handful of small fields per participant, prunable once a user's conversion window has fully closed and their cohort is sealed (post-seal, only the aggregated histogram must survive; the per-user progress row can be dropped). It is a real, new per-user cost, and it is the direct storage consequence of promoting funnels out of FR-022's design-only status. It is **not** the only sheet that touches the durable spine — economy adds an optional last-known-balance-per-user×currency (sheet 02 §5) and derived-KPIs adds per-payer period spend + a first-purchase-day flag (sheet 07 §5); all per-user/per-payer spine draws are reconciled against SC-007 in the **spine-budget ledger** (see `metrics/README.md`). Funnels' progress record is the largest of these because it is keyed per participant, not per payer. **No DDL / column types / Redis keys are specified here — only that this state must be derivable and maintained; /plan chooses storage.**

---

## 6. Edge Cases & Failure Modes

- **Conversion-window expiry (§G clock)**: a user who reaches step k−1 but emits no step-k match before `step1_entry_time + conversion_window` is a **permanent drop-off at k**; their `furthest_step_reached` freezes. Window is measured on skew-corrected client-event-time (§G), so a late-but-in-window event still counts if its *corrected* time is inside the window. Once the window closes, the participant contributes to the final histogram and the per-user progress row is prunable.

- **Out-of-order / late arrival mid-funnel (§G, §F)**: batches arrive out of order (offline buffering). Because advancement is gated on **corrected event-time ≥ prior-step time** and is **monotone**, a late-arriving step-k event whose corrected time is validly after step k−1 and within-window still advances the user even if it is *received* after a later-numbered event — as long as it lands before the day-seal. An event arriving out of receive-order but with an *earlier* corrected time never regresses progress (monotone). Dedup (§F, `event_id` + 24h) prevents a resent step event from being processed twice; funnel advancement is additionally idempotent by construction (monotone step index), so even a >24h duplicate cannot over-advance.

- **Users who never finish**: the common case — they simply sit at their `furthest_step_reached` and appear as drop-off at the next step. No special handling; the monotone histogram captures them. Immature cohorts (window still open) must not count these as final drop-offs — mask as provisional (§4).

- **Sealed-day interaction with an in-flight funnel spanning the seal boundary (the sharp one, §G 48h seal)**: a funnel's conversion window (up to 30d) is far longer than the §G 48h day-seal grace. A user whose Step-1 entry is on day D may legitimately emit step-k events many days later, *after day D has sealed*. This is **not** a violation of §G immutability, because **funnel-progress state is keyed by the user and the Step-1-entry cohort, not by the step-k event's day**: advancing the user updates their progress record and the *Step-1 cohort's* histogram — it does **not** mutate any sealed daily aggregate of the step-k event's own day. The step-k event, qua raw event, still obeys §G (if it arrives >48h late for *its own* day it is quarantined from *that day's* economy/count aggregates) — but its role in *advancing a funnel* uses its corrected timestamp against the still-open conversion window, which the per-user progress state keeps alive independently of daily seals. The funnel cohort's histogram is therefore **not finalized at the §G 48h seal; it finalizes only when the conversion window closes** (`cohort_day + conversion_window`, plus a short late-arrival grace). Until then the cohort is provisional (§4). *Corollary constraint*: a step-k event that arrives after **both** the conversion window has closed **and** its own day has sealed is doubly-late — it cannot advance the (now-final) funnel cohort and is quarantined for its own day; it lands in the raw quarantine file, out of headline funnel numbers (acceptable tail, mirrors §G residual-error posture).

- **Redis loss mid-window (§E, SC-008)**: if per-user funnel-progress state is held partly in the transient hot tier, a Redis loss could drop in-flight advancement. Progress state that must survive a crash is **durable-tier state, not transient counters** — the write-ahead raw-file ordering (§E/FR-009) means the advancing events are in the raw file, but v1 ships no automated replay (§E), so the *manual rebuild floor* is the recovery path for funnel progress too. This inherits §X-1's "no automated rebuild tooling in v1" gap and adds a wrinkle: rebuilding funnel progress from raw requires replaying a user's ordered events, which is exactly the per-user path replay — feasible from the raw file, but explicitly a *manual* procedure in v1 (Open Question §OQ-5).

- **Purchase step & the §D trust boundary**: a funnel ending in `purchase` advances on the **server-verified** purchase row (§D), keyed by `transaction_id`, `environment == prod` (sandbox excluded). The client zero-money context-companion event MUST NOT advance the funnel — otherwise a spoofed client fakes conversions. Sandbox/unverified purchases never advance a revenue-terminating funnel.

- **Anon→identified split (§v1 out-of-scope merge)**: a user who advances steps while anon (SDK `anon_id`) then logs in mid-window gets a new `user_id`; their progress does not carry across (anon↔user merge is out of scope). Result: possible under-counted conversions / phantom drop-off for funnels straddling the login boundary. Accepted v1 limitation; flagged for the operator (Open Question §OQ-6). Sessions keep a stable `session_id` across the transition, but funnel progress is keyed on `user_id`, not `session_id`, so this does not save it.

- **Definition change mid-flight (§3)**: if the operator edits the funnel while cohorts are in-flight, in-flight progress records (tagged with the old `funnel_definition_version`) close out under the old definition; new Step-1 entries start under the new version. The two versions' histograms are never summed (§3).

---

## 7. Open Questions

- **§OQ-1 — FUNNELS PROMOTION TO v1 (scope decision) [RESOLVED - DECLINED 2026-07-17]**: The scope promotion was declined. FR-022 stands: funnels are design-only in v1. The per-participant progress spine is not carried in v1's spine ledger. All per-step timing, attribution variants, and progress-row pruning discussions below remain valid as v2-ready design — they are forward-compatible notes, not v1 commitments. Metrics/README.md records the decision.

- **§OQ-2 — Ordering-mode support surface [LEANING]**: `strict` mode needs "immediately-next event," which the fixed per-user state cannot verify without adjacent-event context. *Default: ship only `sequential-with-others-allowed` (and trivial `any-order` as a set check) in v1; mark `strict` as unsupported-in-v1 rather than half-implementing it.*

- **§OQ-3 — Per-step time-to-convert granularity [LEANING]**: full per-step medians require K bounded per-user timestamps vs. just entry+last-advanced for overall timing. *Default: overall + furthest-step time-to-convert only in v1; full per-step timing is a bounded-cost upgrade if requested.*

- **§OQ-4 — Attribution: first-touch vs any-touch [LEANING]**: any-touch (re-anchor on every Step-1 recurrence, best-window) needs per-user Step-1 event history — not results-only-friendly. *Default: first-touch only in v1; any-touch deferred (would require raw or unbounded per-user path history).*

- **§OQ-5 — Funnel-progress rebuild runbook [OPEN, ties to §X-1]**: §X-1 already flags no automated raw-file rebuild tooling in v1; funnel progress rebuild is strictly harder (per-user ordered-path replay). *Recommendation: document the manual per-user replay procedure alongside §X-1's runbook; automated funnel replay stays deferred.*

- **§OQ-6 — Anon→identified funnels [LEANING, ties to §v1 merge deferral]**: funnels straddling login mis-attribute because progress is keyed on `user_id` and anon↔user merge is out of scope. *Default: document the limitation; recommend operators define funnels whose Step-1 occurs post-login where possible; full fix waits on anon↔user merge (out of scope v1).*

- **§OQ-7 — Progress-row lifecycle / pruning [LEANING]**: to bound the SC-007 cost, per-user progress rows should be prunable once the conversion window closes and the cohort seals (only the aggregated histogram survives). *Default: prune per-user funnel-progress rows after `cohort_day + conversion_window + late-grace`; retain only the sealed histogram + timing summaries. Confirm the retention window at /plan.*

- **§OQ-8 — Funnel-cohort finalization vs §G seal [LEANING]**: a funnel cohort finalizes at `cohort_day + conversion_window`, which is later than the §G 48h daily seal; the two seal clocks differ and the dashboard must not treat the §G daily seal as funnel-final. *Default: funnel cohorts carry their own "window-closed" finalization flag independent of the §G day-seal; render provisional until closed.*
