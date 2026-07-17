# Phases 02 + 04 — Implementation Tasks: Sessions + Retention (Classic Day-N)

**Source spec:** `phases/02-sessions.md`, `phases/04-retention.md`, bridge `phases/02.5-activeness-spine-contract.md` · **Design deps:** `00-foundation.md` (§1.2, §1.3, §2.1–2.3, §3.1 steps 3/5/7/8, §3.2/§3.2.1, §3.3, §4.1–4.4, §4.7, §5, §6), `spec.md` (FR-004, FR-015..FR-017, SC-005, SC-007), `metrics/05-sessions.md`, `metrics/03-retention.md`, `08-client-sdk.md` §2.1 (SDK-side session close, read-only here) · **Status:** task-list draft (2026-07-17)

> **Why combined.** Sessions (02) and Retention (04) are one implementation unit: 02 owns the `session` kind and its day results; 04 owns `USER_SPINE` + the retention projections; and 02 **executes both 04-owned durable-immediate spine sequences** (bridge 02.5 A/B) inside its own step-7 path. There is exactly one write site for the spine, and it lives in 02's worker. Splitting them across two task lists would fracture that single write site. Tasks are grouped by concern; the phase-tag in each `T-` id (`T-02.*` vs `T-04.*`) records which phase *owns* the artifact, not which worker touches it.

---

## 0. Scope & dependencies

**What this builds.** The engagement/activeness core of the platform. Phase 02 defines the `session` typed kind, its strict validation + trusted-time derivation, the midnight split, and two per-game×day result tables (`SESSION_DAY_RESULT`, `ACTIVE_USER_DAY`). Phase 04 defines the per-user spine (`USER_SPINE` — `first_seen` + `active_days_bitmap`) plus the two retention projections (`COHORT`, `RETENTION_CELL`), the classic Day-N read model, and its masks. The seam between them — the **durable-immediate spine writes** (sequence A first-session seed; sequence B session-start bit), executed in 02's session path on 04's behalf per bridge 02.5 — is the load-bearing part of this list and is tasked out atomically.

**Must exist before this phase starts** (per `phases/README.md` dep table: 02 depends on 01; 04 depends on 01, 02):
- Phase 01's front-door: the routed record (Foundation §3.1 "typed-kind handoff" — full envelope + resolved kind + stamped wire `v` + corrected event-time/logical day + dedup-passed + seal-state verdicts), the shared `dedup` domain (Foundation §4.1), `EXCEPTION_TALLY` write path (Foundation §1.2), `EVENT_CATALOG`/`EVENT_DAY_COUNT` (every accepted kind still feeds these), the raw write-ahead append (step 4), and `GAME.config`.
- Foundation backbone steps 1–6, 9 (unchanged); the flusher (Foundation §3.2), rehydrate-on-miss + `seeded` marker (§2.3), the class-M/S merge rules (§3.2.1), and `reporting_offset` / `logical_day` (§4.7).
- Phase 02 must be built before Phase 04's projections can be verified, because the bitmap bits (04's truth) are written only by 02's session path.

**FR / SC this phase is accountable for:**
- **FR-004** — stable game-provided `user_id` anchors the spine row + cohort; SDK anon id rides the envelope (anon→user merge out of v1, Foundation §4.6).
- **FR-015** — on the user's first observed **session**, create exactly one `(game_id, user_id, first_seen, active_days_bitmap)` record.
- **FR-016** — per qualifying session, compute day-offset from `first_seen`, set the bit **only if unset**, and increment the cohort's day-N tally (set-once idempotency).
- **FR-017** — dashboard shows D1/D7/D30 as returned÷cohort, labelled "classic Day-N retention", immature cohorts masked N/A.
- **SC-005** — reported D1/D7/D30 match hand-computed cohort retention exactly (the retention Independent Test).
- **SC-007** (shared guard) — session analytics adds **no** new per-user structure; the only per-user draw is `USER_SPINE`.

---

## 1. Task list

### 1a. Schema — result tables + spine (Postgres, logical model per Foundation §1.2)

- [ ] **T-02.1** Define `SESSION_DAY_RESULT` table — key `(game_id, utc_day)`, columns `session_count`, `duration_sum_ms`, `sessions_touching` — *cite:* 02 Design ER (SESSION_DAY_RESULT row), Foundation §1.2. Pure result cell; 1 row per game × logical day. No per-session rows.
- [ ] **T-02.2** Define `ACTIVE_USER_DAY` table — key `(game_id, utc_day)`, column `members` (exact `user_id` set v1) — *cite:* 02 Design ER, Foundation §1.2. `members ⊆` that game's `USER_SPINE` users; it is a **projection** of the bitmap (rebuildable via spine scan), kept for read speed.
- [ ] **T-04.1** Define `USER_SPINE` table — key `(game_id, user_id)`, columns `first_seen` (write-once; stored UTC epoch — its logical day is cohort + Day-0 anchor), `active_days_bitmap` (one bit per day-offset from `first_seen`, set-once) — *cite:* 04 Design ER, Foundation §1.2/§1.3 (core spine tier). This is the *only* new per-user structure in these two phases (SC-007).
- [ ] **T-04.2** Size the `active_days_bitmap` span to `max(retention_day_targets) + ~15 d` headroom (default targets `[1,7,30]` → span 45) — *cite:* 04 Design ER ("Bitmap span"), 04 §6. Offsets beyond the span are untracked by design; widening past the tracked horizon is forward-only.
- [ ] **T-04.3** Define `COHORT` table — key `(game_id, cohort_date)`, column `cohort_size` — *cite:* 04 Design ER, Foundation §1.2. Projection of spine `first_seen` days; ≤ 1 row per game × logical day with ≥ 1 new user.
- [ ] **T-04.4** Define `RETENTION_CELL` table — key `(game_id, cohort_date, day_offset)`, column `retained_users` — *cite:* 04 Design ER, Foundation §1.2. Projection of spine bits; sparse (only touched offsets materialize; an absent mature cell reads 0). The `(cohort × offset)` set of rows **is** the heatmap triangle.
- [ ] **T-04.5** Register `USER_SPINE` as the sole per-user draw for these phases in the spine ledger (`metrics/README.md`) if not already present; assert no other per-user durable table is introduced — *cite:* Foundation §1.3 (spine tiers; new per-user draws require a ledger flag), SC-007. (Verification/guard task, not a new structure.)

### 1b. Config — the knobs (read from `GAME.config`, all forward-only)

- [ ] **T-02.6** Wire the three session knobs from `GAME.config`: `session_inactivity_timeout_min` (default 30, 1–240 — SDK-side boundary rule, server never re-times), `session_max_duration_cap_min` (default 720, 1–1440 — server sanity clamp), `session_min_duration_ms` (default 0, 0–60000 — single-event floor) — *cite:* 02 §6, `metrics/05-sessions.md` §3. All **forward-only**: never re-bucket already-emitted sessions or sealed aggregates.
- [ ] **T-04.6** Wire the retention knobs from `GAME.config`: `retention_day_targets` (default `[1,7,30]`; widening past tracked horizon is forward-only), `retention_min_cohort_size` (default 30 — **display-only** read predicate). Read `session_inactivity_timeout_min` as inherited-not-owned, and platform `reporting_offset` (Foundation §4.7, set-once at install) — *cite:* 04 §6.

### 1c. Ingest / validation — `session` kind (Foundation §3.1 step 3, executes in 02's worker on the routed record)

- [ ] **T-02.7** Register `session` as a strictly-validated typed kind consuming the routed record (Foundation §3.1 typed-kind handoff); no new route (path is pinned `/v1/events`) — *cite:* 02 Design API surface, Foundation §1.1/§3.1. 02 is one of the three typed consumers; it never re-derives a front-door verdict.
- [ ] **T-02.8** Implement step-3 shape check of required `props`: `session_id` (opaque string, never parsed), `session_start_time` + `session_end_time` (parseable timestamps), `duration_ms` (int ≥ 0). Absent/malformed required field → **quarantine** (raw-appended-with-marker + `quarantined_typed` tally, Foundation §4.4) — *cite:* 02 Design step 3(1) + API table. (after T-02.7)
- [ ] **T-02.9** Treat `reason ∈ {timeout, app_close, reconciled}` as optional; an **unknown value → treated as absent**, event accepted (never a quarantine cause; informational only) — *cite:* 02 Design step 3(1) + API table.
- [ ] **T-02.10** Skew-correct both payload timestamps with the step-2 envelope skew (same value, same 60 s dead-band); future-clamp each to server-now — *cite:* 02 Design step 3(2), Foundation §4.2. (after T-02.8)
- [ ] **T-02.11** Server-recompute the **trusted** duration: `trusted_duration = corrected_end − corrected_start`, clamped 0 if negative, then to `session_max_duration_cap_min`, then floored by `session_min_duration_ms`. Client `duration_ms` is a sanity signal only — never folded, never a rejection cause; all clamps **accept** — *cite:* 02 Design step 3(3), `metrics/05-sessions.md` §6. (after T-02.10)
- [ ] **T-02.12** Build the **trusted interval** `[corrected_start, corrected_start + trusted_duration)` and use it for all split math (never the raw client end). Assert the interval overlaps **at most two adjacent logical days** by construction (cap range ≤ 1440 min) — *cite:* 02 Design step 3(4). (after T-02.11)
- [ ] **T-02.13** Derive the **governing day = corrected START logical day** (`logical_day(corrected_start)`, Foundation §4.7) — it keys the count, the bit, the `act` membership, and the step-5 seal check — *cite:* 02 Design step 3(5), Foundation §4.7. (after T-02.10)

### 1d. Seal gating — start-day-atomic (Foundation §3.1 step 5)

- [ ] **T-02.14** Gate the whole event on the **corrected start day's** seal state (from the routed record): start day sealed ⇒ quarantine the whole event (quarantine tail + `sealed_late` tally) — **even when the end day is still open** (reachable for a `reconciled` spanner between the two seals). No tail-only fold — *cite:* 02 Design step-5 refinement, Foundation §4.3, bridge 02.5 §5 ("Sealed day — full stop"). (after T-02.13)
- [ ] **T-02.15** Encode the no-partial-split lemma as an assertion/comment: because seal times increase strictly with the day, an open start day implies every touched day is open — the split is all-or-nothing, one conservative gate on the earliest touched day — *cite:* 02 Design step-5 lemma, Foundation §2.3. (after T-02.14)

### 1e. Durable-immediate spine writes — bridge 02.5 sequences A + B (Foundation §3.1 **step 7**, straight to Postgres, NOT flush-mediated)

> These run **only** for the `session` kind, **only** after the event has passed steps 1–6 (accepted, skew-corrected, deduped, in an open corrected day), and **strictly before** step 8. Sequence A runs immediately before B for the same event. This is the platform's one cross-story durable-write delegation; 04 owns the semantics, 02 owns the surrounding path.

- [ ] **T-04.7 (7a — Sequence A seed)** `USER_SPINE` insert-if-absent of `(game_id, user_id, first_seen = corrected session_start)`; the insert **reports created?** Write-once — never back-date `first_seen` — *cite:* bridge 02.5 §2(1), 04 Design sequence A / DD-1, Foundation §3.1 step 7, §5 ownership row (`USER_SPINE.first_seen` — written by 02). Seeding from the corrected **start** (same value 7b uses) makes the seeding event's own offset 0. (after T-02.13, T-02.14)
- [ ] **T-04.8 (7b — offset math)** Compute `offset = logical_day(corrected session_start) − logical_day(first_seen)` (spine row guaranteed by 7a for this same event). `reporting_offset` shifts both operands equally (translation-invariant) — *cite:* bridge 02.5 §3(1), 04 Design 7b, Foundation §4.7. (after T-04.7)
- [ ] **T-04.9 (7b — negative-offset guard)** `offset < 0` (bounded `≥ −2` by 48 h window geometry; sole surviving cause = in-grace processing race): **skip the bit AND the counter; tally `negative_offset`** (Foundation §1.2 enum); never back-date `first_seen`; the session still counts/splits in 02's day aggregates — *cite:* bridge 02.5 §5 (Negative offset), 04 Design 7b + OQ-3, Foundation §1.2. *Rejected alt (do not implement): clamp-to-bit-0.* (after T-04.8)
- [ ] **T-04.10 (7b — over-horizon guard)** `offset >` bitmap span ⇒ **skip bit, no counter — silent no-op by design** (untracked, not exceptional; no tally) — *cite:* bridge 02.5 §5 (Over-horizon), 04 Design 7b. (after T-04.8)
- [ ] **T-04.11 (7b′ — set-once bit, durable-immediate)** One atomic conditional durable write into `USER_SPINE.active_days_bitmap` at `offset`: **set iff unset, report the 0→1 transition**. Already set ⇒ **full no-op**, and step 8b is skipped entirely. Straight to Postgres, never flush-mediated — *cite:* bridge 02.5 §3(2), 04 Design 7b′, Foundation §3.1 step 7 / §5 (`active_days_bitmap` — written by 02, durable-immediate), FR-016. This single guard is what makes dedup-misses beyond 24 h, reprocessing, and midnight-span-splits safe. (after T-04.9, T-04.10)
- [ ] **T-04.12 (ordering invariant)** Enforce **durable write ≺ counter** for both sequences: 7a/7b′ (Postgres) strictly precede 8a/8b (Redis increment). A crash between leaves the projection *behind* the spine truth, never ahead — reconcilable by spine re-scan — *cite:* bridge 02.5 §4, 04 Design "Exactly-once coupling", Foundation §6. (after T-04.7, T-04.11)
- [ ] **T-02.16 (sequence A only reached by `session`)** Assert no other kind reaches sequence A or B (no seeding site anywhere else; 01's front-door seeds nothing) — *cite:* bridge 02.5 §1 + §8 conformance checklist, Foundation §7 (activeness = session-start). (after T-04.7)

### 1f. Redis hot updates — the flushed projections (Foundation §3.1 **step 8**, all rehydrate-on-miss)

> Everything here is **transient-and-losable** (un-flushed drift ≤ flush cadence, Foundation §6). Nothing in these two phases is durable-immediate *in Redis* — the spine bit already went to Postgres in step 7.

- [ ] **T-02.17** Define Redis domain `sess`: key `{game_id}:sess:{logical_day}`, type **hash**, fields `session_count`/`duration_sum_ms`/`sessions_touching`, TTL ~72 h from day end, **flush class M** — *cite:* 02 Design Redis table, Foundation §2.1 (owned tag), §2.2, §2.3, §3.2.1 (class M — `GREATEST` + `HSETNX` seed).
- [ ] **T-02.18** Define Redis domain `act`: key `{game_id}:act:{logical_day}`, type **set** (HLL at same key under scale lever), `user_id`s with a session **start** that day, TTL ~72 h, **flush class S** — *cite:* 02 Design Redis table, Foundation §2.1/§2.2/§2.3, §3.2.1 (class S — set-union / `PFMERGE`).
- [ ] **T-04.13** Define Redis domain `ret`: key `{game_id}:ret:{logical_day}`, type **hash**, fields `cell:{cohort_date}:{offset}` (running absolute `retained_users`) + `size` (running absolute `cohort_size` for the cohort born this day), TTL ~72 h, **flush class M**. HLL is **forbidden** for `ret` — *cite:* 04 Design Redis table, Foundation §2.1/§2.2 (never HLL for retention), §3.2.1 (class M).
- [ ] **T-04.14** Implement the **bucket-day rule**: a retention cell lives in the bucket of its **activity day** `d = cohort_date + offset`, not its cohort day (Foundation §2.3 retention carve-out). Day `d`'s bucket holds `size`, `cell:{d}:0`, `cell:{d−1}:1`, `cell:{d−7}:7`, … At most 3 open `ret` buckets/game — *cite:* 04 Design Redis "Bucket-day rule". (after T-04.13)
- [ ] **T-02.19** Implement `sess`/`act` step-8 updates on the **start day**: `session_count += 1`, `sessions_touching += 1`, `duration_sum_ms += dur_on_day(s, start_day)`, `SADD user_id` to `act` — *cite:* 02 Design step-8 table. (after T-02.12, T-04.11)
- [ ] **T-02.20** Implement the **end-day** `sess` update, iff the trusted interval has positive overlap with a second day: `sessions_touching += 1`, `duration_sum_ms += dur_on_day(s, end_day)` — **no count**, and **no** second `act` set (activeness is start-day only) — *cite:* 02 Design step-8 table + §5 ("touches two `sess` hashes … exactly one `act` set"). (after T-02.19)
- [ ] **T-02.21** Implement `dur_on_day(s, D) = max(0, min(end_s, D_end) − max(start_s, D_start))` over the **trusted interval** for the split attribution — *cite:* 02 §2 formulas, 02 Design step 3(4). (after T-02.12)
- [ ] **T-04.15 (8a)** *Only if 7a created the row:* rehydrate-on-miss, then `size += 1` in `{game_id}:ret:{c}`, `c = logical_day(first_seen)` = this session's corrected start day (open by construction — start-day gate governs) — *cite:* bridge 02.5 §2(2), 04 Design 8a. (after T-04.7, T-04.13)
- [ ] **T-04.16 (8b)** *Only on a reported 0→1 transition from 7b′:* rehydrate-on-miss, then `cell:{c}:{offset} += 1` in `{game_id}:ret:{d}`, `d = c + offset` = this event's own corrected start day (open — passed step 5 for `d`) — *cite:* bridge 02.5 §3(3), 04 Design 8b. (after T-04.11, T-04.14)
- [ ] **T-04.17** Implement **rehydrate-on-miss + `seeded` marker** for all three domains: seed `sess`/`ret` fields per-field with `HSETNX` from the durable row (0 if absent), seed `act` via `SADD` of durable members; write the `seeded` marker last; flush skips un-`seeded` buckets — *cite:* Foundation §2.3 (rehydrate + double-seed/half-seed rules), 02 Design + 04 Design ("Rehydrate-on-miss"). (after T-02.17, T-02.18, T-04.13)

### 1g. Flush — Redis → Postgres (Foundation §3.2, on the shared 5-min cadence; owned mappings only)

- [ ] **T-02.22** Register `sess`/`act` buckets in the shared per-domain dirty-registry and map the flush: `sess` hash fields → `SESSION_DAY_RESULT.{session_count,duration_sum_ms,sessions_touching}` (class M: `GREATEST` + `HSETNX`); `act` set → `ACTIVE_USER_DAY.members` (class S: set-union, never blind replace) — *cite:* 02 Design Redis table + Foundation §3.2/§3.2.1. (after T-02.17, T-02.18)
- [ ] **T-04.18** Map the `ret` flush: `cell:{c}:{N}` → `RETENTION_CELL(game, c, N)`; `size` → `COHORT(game, c)` — both class-M absolute upserts (retried flush is a no-op); seal of activity day `d` = final flush then bucket expires — *cite:* 04 Design "Flusher mapping", Foundation §3.2/§3.2.1. (after T-04.13)

### 1h. Read model — dashboard API (Foundation §3.3 uniform merge; sealed=Postgres, open=Redis with last-flush fallback)

- [ ] **T-02.23** Session read surfaces: session-count/day from `SESSION_DAY_RESULT.session_count`; avg length = `duration_sum_ms ÷ sessions_touching` (the **split form**, labelled as such, §S-4 default); sessions/user (window W) = Σ`session_count` ÷ |union of `ACTIVE_USER_DAY.members`|; frequency (W) = Σ`session_count` ÷ Σ per-day |members| (active user-days). All read-time computations, never stored — *cite:* 02 Design read-model table, Foundation §3.3. (after T-02.22)
- [ ] **T-02.24** Mark any window touching an open day **provisional** until seal — *cite:* 02 Design read-model, 02 §2 immature handling. (after T-02.23)
- [ ] **T-04.19** Headline D1/D7/D30 read: `Σ_c retained(c,N) ÷ Σ_c size(c)` over the **fixed mature-cohort set** (`today_logical − c ≥ N`), reading `COHORT` + `RETENTION_CELL` at `N ∈ retention_day_targets` — *cite:* 04 Design read-model table, 04 §2 formulas. (after T-04.18)
- [ ] **T-04.20** Cohort × offset **heatmap triangle** read: per-cell `retained ÷ size`; absent mature cell = 0 % — *cite:* 04 Design read-model, 04 §2. (after T-04.18)
- [ ] **T-04.21** Per-cell liveness: cell `(c, N)` is Redis-merged iff its **activity day** `c + N` is still open — one cohort row can mix sealed historical cells with 1–3 live tail cells (per-cell merge by activity day, Foundation §3.3) — *cite:* 04 Design "Per-cell liveness". (after T-04.20)
- [ ] **T-04.22** Apply the **UI label** "classic Day-N retention" with the contrast tooltip (vs Mixpanel unbounded); annotate offsets beyond a widened horizon "tracking begins <date>" — *cite:* FR-017, 04 §1, 04 Design read-model "Labelling". (after T-04.19)

### 1i. Retention masks + composition guards (read-time predicates; mutate no stored cell)

- [ ] **T-04.23** **Immature-cohort mask**: render **N/A** (never a low number), greyed with "day N not yet elapsed" tooltip, for any cell where `today_logical − cohort_date < N` (`today_logical` = platform logical today, Foundation §4.7) — *cite:* FR-017, 04 §2 immature masking, 04 Design read-model. (after T-04.20)
- [ ] **T-04.24** **Headline composition/survivorship guard**: headline averages over the **fixed set of cohorts mature at N** (a cohort enters the D_N average only once mature at N, and the set is stated), and the **default surface is the heatmap triangle, not a single blended line**; the blended headline is labelled composition-dependent — *cite:* 04 §2 "Headline composition guard". (after T-04.19)
- [ ] **T-04.25** **Small-cohort guard** (orthogonal to maturity): mask cells whose denominator (`cohort_size` or a segment sub-denominator) `< retention_min_cohort_size` (default 30) as **low-confidence** — greyed + sample-size annotation, never hidden, never a bare precise-looking percent; both masks are independent predicates and both apply — *cite:* 04 §2 "Small-cohort masking", 04 §6. (after T-04.20)
- [ ] **T-04.26** Gate any cohort-vs-cohort "X beats Y" callout behind a two-proportion/χ² test (never a raw point comparison) — *cite:* 04 §2 (small-cohort guard, final sentence). (after T-04.25)

### 1j. Recovery + invariants (spine re-scan is the only rebuild path)

- [ ] **T-04.27** Implement the **spine-re-scan re-projection** healing lever: rebuild `COHORT.cohort_size`, `RETENTION_CELL.retained_users`, and `ACTIVE_USER_DAY.members` by popcount-by-offset / membership over `first_seen` + `active_days_bitmap` for a game×day range — **never a raw re-scan** — *cite:* Foundation §1.3, bridge 02.5 §4, 04 Design "Exactly-once coupling", 02 Design ER (rebuild path = spine scan). Covers crash-between-7-and-8 and Redis loss ≤ one flush window.
- [ ] **T-04.28** Add the **D0 = 100 % invariant guard**: assert `bit 0 == 1 for every user with a first_seen` and `COHORT.cohort_size ≡ RETENTION_CELL(c, 0)`; alarm on any failure (catches a flooring/desync regression, e.g. a stray separate pass re-deriving the D0 bit) — *cite:* 04 Design read-model "Invariant test", bridge 02.5 §6 (D0=100 %). (after T-04.7, T-04.11)
- [ ] **T-02.25** Document (comment/runbook) the accepted idempotency residual: within 24 h a resent close never reaches steps 7–8 (`event_id` dedup); beyond 24 h a replay re-ORs the bit (no-op) + re-`SADD`s (no-op) but **double-counts** `session_count`/`duration` — the accepted non-money residual (`session_id` is never a dedup/storage key) — *cite:* 02 Design "Idempotency ledger", Foundation §4.1.

### 1k. Tests (verify against hand-computed truth)

- [ ] **T-02.26** Golden-example test replaying 02 §2's worked example (S1 spanning midnight 07-15→07-16, S2 on 07-16): assert `session_count(07-15)=1`, `session_count(07-16)=1`, `total_duration(07-15)=20 min`, `total_duration(07-16)=45 min`, `avg(07-16)=22.5 min`, sessions/user=2.0, frequency=1.0 — *cite:* 02 §2 worked example. (after T-02.23)
- [ ] **T-02.27** Consume 08's checked-in golden-event fixtures for the terminal `session` event (incl. `reconciled`) at the ingest end — one fixture set, both ends of the wire — *cite:* 08-client-sdk.md §Golden-event fixtures (read-only dependency). (after T-02.8)
- [ ] **T-04.29** Synthetic-population test for **SC-005**: users with known first-seen + return days → assert D1/D7/D30 match hand-computed cohort retention exactly, including immature masking (D7 for a 3-day cohort reads N/A, not 10.5 %) — *cite:* SC-005, spec.md US3 Independent Test, 04 §2 worked example. (after T-04.19, T-04.23)
- [ ] **T-04.30** Idempotency test: resend a `session` event within and beyond 24 h; assert the bit stays set-once and `retained_users` never double-increments (FR-016 set-once); a midnight-span session sets exactly one bit — *cite:* FR-016, 04 §2 bit-set rule, bridge 02.5 §7 worked example. (after T-04.11)
- [ ] **T-04.31** Bridge conformance replay: exercise every row of 02.5 §8's checklist (sequence A/B only for `session`; increment only on created/transition; durable ≺ counter; negative-offset + over-horizon guards present with exact semantics; no spine touch for a sealed day; non-session events tally `no_spine_row`, never blocked) — *cite:* bridge 02.5 §8, §7 worked example. (after T-04.9, T-04.10, T-04.11, T-04.12, T-02.16)
- [ ] **T-04.32** Negative-offset + sealed-late + over-horizon edge tests: in-grace processing race (later-day session seeds `first_seen` before an earlier-day session processes) → `negative_offset` tally, session still counts in `sess`/`act`; genuinely-first session arriving sealed-late → full stop at step 5, no `first_seen`, anchors at next in-grace session — *cite:* bridge 02.5 §5/§7, 04 Design OQ-2, 02 Design step-5 refinement. (after T-04.9, T-02.14)

---

## 2. Cross-phase dependencies

Ownership-matrix (Foundation §5) WRITE-vs-READ for every shared structure these phases touch:

- **`USER_SPINE.first_seen` + `USER_SPINE.active_days_bitmap`** — owner **04**, **written by 02** (durable-immediate, step 7), read by 02 (popcounts), 04, 05, 06. This is the single cross-story durable-write delegation (bridge 02.5). T-04.7 / T-04.11 must run inside 02's worker, not a 04 worker. **Needs from 01:** the routed record must reach 02's step 7 already deduped and seal-checked, so the spine write happens exactly once per processing attempt.
- **Routed record + `dedup` domain + `EXCEPTION_TALLY`** — owner **01**, read/appended-to by 02. **Needs from 01 before T-02.7/T-02.8/T-02.14/T-04.9 can run:** the typed-kind handoff (full envelope + corrected time + logical day + dedup-passed + seal-state), the shared `event_id` 24 h dedup, and the tally write path for `quarantined_typed` / `sealed_late` / `negative_offset` / `no_spine_row` (Foundation §1.2 enum must already include `negative_offset` — amendment landed). 02 never re-derives a front-door verdict.
- **`SESSION_DAY_RESULT` + `ACTIVE_USER_DAY` → 06** — owner **02**, read by 06 (DAU, window unions, stickiness denominator, engagement panels). 06's tasks depend on T-02.22 landing these projections. Also feeds 06/04 the "active = session start" definition.
- **`COHORT` + `RETENTION_CELL` → 06** — owner **04**, read by 06 (new-vs-returning splits) + dashboard. **`first_seen` → 05/06** as conversion / new-vs-returning / install-cohort anchor. Never-sessioned users have **no spine row** → 05/06 resolve their install dims to `unknown` (Q1 / bridge 02.5 §6); these phases owe 05/06 that "no row is a valid state" contract.
- **Phase 02 must be implemented before Phase 04 can be verified** — 04's projections are downstream of the bits 02 writes; SC-005 cannot pass until 02's session path (T-02.7..T-04.16) is complete.
- **08 (client SDK)** — read-only here: the terminal-`session`-event contract (sendBeacon/`pagehide` reliable close, `reason=reconciled` backstop, `duration = last_activity` end) is 08's; 02 only consumes the emitted event and its golden fixtures (T-02.27). No task in this list changes SDK behavior.

---

## 3. Acceptance & test mapping

| FR / SC | Satisfied by | Verified how |
|---|---|---|
| **FR-004** (stable `user_id` anchors spine + cohort; anon rides envelope) | T-04.1, T-04.7 | Spine keyed `(game_id, user_id)`; `first_seen` seeded from the id current at session end; anon→user merge out of scope (Foundation §4.6). |
| **FR-015** (first session ⇒ exactly one `(game_id,user_id,first_seen,bitmap)` record) | T-04.1, T-04.7, T-02.16 | Insert-if-absent (write-once, reports created); only `session` kind reaches seeding. Verified by T-04.29/T-04.31 (created-once) + T-04.28 (D0 invariant). |
| **FR-016** (compute offset, set bit only if unset, increment cohort tally) | T-04.8, T-04.9, T-04.10, T-04.11, T-04.16 | Set-once conditional bit, transition-reported; 8b fires only on 0→1. Verified by **T-04.30** (idempotency: no double-increment on resend/replay/midnight-span). |
| **FR-017** (D1/D7/D30 = returned÷cohort, labelled classic Day-N, immature masked N/A) | T-04.19, T-04.22, T-04.23 | Read-model division + label + mask. Verified by **T-04.29** (immature D7 reads N/A, not a low number). |
| **SC-005** (D1/D7/D30 match hand-computed exactly) | T-04.19, T-04.23, T-04.24 | **T-04.29** — synthetic population, hand-computed truth (spec.md US3 Independent Test; 04 §2 worked example, headline 42.3/23.0/11.0). |
| **SC-007** (no new per-user structure beyond the spine) | T-04.7, T-04.1, T-02.1, T-02.2 (result tables only) | **T-04.5** — spine-ledger guard: session analytics adds no per-user table; only `USER_SPINE` is a per-user draw. |
| Session definition (§X-2) — count/duration/frequency correct | T-02.11, T-02.19, T-02.20, T-02.21, T-02.23 | **T-02.26** — 02 §2 worked example replayed (start-day count, midnight duration split, split-form average, sessions/user, frequency). |
| Sealed-day + negative-offset + reconcile edges | T-02.14, T-04.9, T-04.10 | **T-04.32** + **T-04.31** — bridge 02.5 §5/§7 scenarios (in-grace race, sealed-late first session, over-horizon). |

---

## 4. Open considerations / flags for /plan

1. **Bitmap storage realization (below the no-DDL altitude).** 04's Design + `metrics/03-retention.md` §5 explicitly defer the *column type* for `active_days_bitmap` (Postgres `bytea` vs `bit varying` vs an integer-array offset set). The set-once atomic conditional write (T-04.11) needs an efficient "test-and-set bit N, report transition" primitive under concurrency; the chosen storage must support that atomically (or the write must be serialized per `(game_id, user_id)`). Load-bearing for the exactly-once coupling — flag for /plan.

2. **Durable-immediate spine write under concurrency + crash (the seam's sharpest edge).** T-04.7 and T-04.11 are two Postgres writes that must both land before the Redis increments (T-04.12), for the *same* event, in 02's worker, and must be crash-safe such that the projection can only lag the spine. /plan must pin: is 7a+7b′ one Postgres transaction or two ordered statements? What isolates two workers seeding the same new user (the negative-offset `≥ −2` race, T-04.9)? Foundation says "insert-if-absent" + "atomic conditional bit" — the concrete mechanism (upsert-on-conflict, advisory lock, `SETBIT`-style) is a /plan choice with correctness consequences.

3. **`gen`/atomicity class not needed here (recorded).** Both `sess` and `ret` are class M and `act` is class S (all self-healing under torn/half-seeded reads); no class-N `gen` machinery applies to these two phases. Recorded so /plan does not accidentally import the monetization `gen` complexity into retention. Retention counters only ever `+=` within a day (no in-day MOVE), which is *why* class M is safe here — a design fact worth an assertion in the flusher.

4. **Distinct-user counting exactness at scale (§S-3, the named scale lever).** `ACTIVE_USER_DAY.members` is an exact `user_id` set in v1. The HLL lever (Foundation §9.2, count-only) may replace it for DAU/WAU/MAU **counts** but is **forbidden** for any membership-bearing read (window unions for sessions/user + frequency, and never retention). If a deployment flips the lever, sessions/user + frequency degrade to `PFMERGE` approximations while retention stays exact on the bitmap — /plan must keep an exact structure for membership-dependent reads or accept degrading only the count metrics.

5. **`today_logical` boundary computation.** Both the immature mask (T-04.23) and provisional marking (T-02.24) depend on `today_logical = utc_day(now + reporting_offset)` — computing it in raw UTC leaves the mask edge off by up to a day near the boundary (04 §2 warns of exactly this). /plan should centralize the logical-today source so mask, seal, and floor never disagree.

6. **Segmented retention shreds cohorts (small-cohort guard is load-bearing, not cosmetic).** T-04.25's `retention_min_cohort_size` guard becomes critical once retention is sliced by region/payer-tier (04 §2), but **segmented retention itself is not defined in these phases** — the `session` event's context props exist on the envelope, yet no task here rolls retention up by segment. If segmented retention is in v1 scope for the panel, it needs its own tasking (likely a 06 or panel concern) with sub-denominators that feed the same guard; flag to reconcile scope.

7. **Server-SDK sessions out of scope (§S-1) — cross-check with 06/09.** v1 server events carry a passed-in `session_id` or none and **never** set a retention bit or start/close a session (metrics §S-1 recommendation (b), adopted). No task enforces "a server-provenance event never reaches sequence B" beyond the `session`-kind gate (T-02.16). If the server SDK (09) can emit `kind=session`, /plan must decide whether that is allowed to set activeness — the current design implies session analytics is client-engagement only.

---

*End of task list. Read-only pass over all cited specs; no spec file was modified.*
