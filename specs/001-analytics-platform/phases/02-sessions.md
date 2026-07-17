# Phase 02 — Sessions

**Feature**: 001-analytics-platform · **Story**: the shared engagement / activeness anchor · **Reserved kind owned**: `session` · **Status**: Draft
**Depends on**: Phase 01 (ingest substrate). **Blocks**: Phase 04 (retention), Phase 06 (DAU) — both consume the session definition locked here.
**Deeper reference**: [`../metrics/05-sessions.md`](../metrics/05-sessions.md). **Resolves** research §X-2 (session definition) and §B-1 ("active" = session).
**Excluded here** (→ later per-phase design): SDK timer implementation, key layouts, DDL.

---

## 1. Story understanding

**The story.** Players open the game, play for a while, drift away, come back later. A **session** is one such bout of engagement — the atomic unit everything else measures activeness in.

**The question it answers.** *How often and how long do players engage?* Session count, session length, sessions per user, session frequency. But its bigger job is to be the **shared anchor**: "active on a day" (for retention and DAU) means *a session started that day*, and `sessions_before_purchase` (for monetization) counts sessions.

**Locked session definition (this is the §X-2 resolution — every other phase inherits it):**
- **SDK-managed, not server-inferred.** The client SDK owns session lifecycle and mints `session_id`. Server-inferred sessionization is impossible under results-only storage (it would need per-user last-event memory / raw events in the hot window). The SDK emits one self-contained `session` fact — results-only-native.
- **Start.** First tracked event after SDK init, or the first event after the previous session expired. A fresh `session_id` is minted at that moment.
- **End.** When the inactivity timeout elapses with no tracked event (**default 30 min**, on skew-corrected client time), OR on an explicit app-close/background signal — whichever fires first.
- **Why 30 min.** Cross-industry default (GA4 / Adjust / GameAnalytics). Shorter over-splits an interrupted player; longer merges distinct bouts. Configurable per game.
- **`session_id`.** Client-generated opaque id (ULID preferred, UUID fine), unique per game+user; the server treats it as an opaque grouping key and never parses it.
- **What emits the kind.** The SDK emits **exactly one** `kind = session` event **at session end** (or reconciled at next init if the app was killed). It carries `session_id`, `session_start_time`, `session_end_time`, `duration_ms`. **This single event is the sole thing that marks a user "active on a day"** — the retention bit is driven by the session's **start** UTC day (§B-1). No other event kind sets it.
- **Midnight-spanning: SPLIT for duration, START-day for counting.** A session crossing UTC midnight is **counted once in its start day** (write-once, immutability-safe) while its **duration is split pro-rata** across each UTC day it overlaps (honest per-day engaged-time).

**Trust boundary.** Session data is client-reported and spoofable — accepted. Sessions are engagement, not money. The only server hardening is a sanity clamp on absurd durations.

---

## 2. How it is calculated

**Time-bucketing.** UTC day (§G). **Count/frequency** key on the session's **start** UTC day; **duration** splits across the days it overlaps. **Grain:** per `game_id` × UTC-day; sessions-per-user rolls up over a window.

**Formulas (definitional):**
```
session_count(D)      = |{ sessions whose session_start_time is on UTC day D }|         (start-day → write-once)
dur_on_day(s, D)      = max(0, min(end_s, D_end) − max(start_s, D_start))               (overlap of session s with day D)
total_duration(D)     = Σ_s dur_on_day(s, D)
avg_session_length(D) = total_duration(D) / sessions_touching(D)                        (sessions with any overlap on D)
sessions_per_user(W)  = total_sessions_in_W / distinct_users_with_a_session_in_W
session_frequency(W)  = total_sessions_in_W / active_user_days_in_W                     (active user-day = (user,day) with ≥1 session start)
```

### Worked example (one game, one player, timeout = 30 min)

Skew-corrected client times, UTC:
- `07-15 23:40` event A → **S1 starts** (`s1`).
- `07-15 23:52`, `07-16 00:20`, `07-16 00:35` → all < 30 min apart → still S1 (spans midnight).
- No event 30 min → **S1 ends** at `00:35`. SDK emits: `start=07-15 23:40, end=07-16 00:35, duration = 55 min`.
- `07-16 09:00` event E → **S2 starts**; `09:10` event F; no event 30 min → **S2 ends** at `09:10`, duration 10 min.

Results:
- **Session count**: S1 counts in start day **07-15** → `session_count(07-15)=1`; S2 → `session_count(07-16)=1`. (S1 crossing midnight does **not** add to 07-16.)
- **Retention bits** (§B-1): S1 start day 07-15 sets 07-15's bit; S2 sets 07-16's bit → user active both days.
- **Duration split**: S1 → 20 min on 07-15 (`23:40–24:00`) + 35 min on 07-16 (`00:00–00:35`) = 55 ✓. S2 → 10 min on 07-16. So `total_duration(07-15)=20`, `total_duration(07-16)=45`.
- **Avg length**: `sessions_touching(07-15)=1` → 20 min; `sessions_touching(07-16)=2` (S1 tail + S2) → 45/2 = **22.5 min**.
- **Sessions/user** over [07-15, 07-16]: 2 sessions / 1 user = **2.0**.
- **Frequency**: 2 sessions / 2 active-user-days = **1.0**.

---

## 3. Data needed (input)

Rides the canonical envelope. This story adds the reserved `session` typed kind — the payload of the **terminal `session` event only**:

| Field | Meaning | Req/Opt |
|---|---|---|
| `session_id` | The session this event closes (matches the id stamped on that session's other events). | required |
| `session_start_time` | First-event client time of the session (skew-correctable). | required |
| `session_end_time` | Last-event client time, or inactivity-expiry / app-close time. | required |
| `duration_ms` | `end − start`; server **recomputes** as the trusted value (client value is a sanity check). | required |
| `reason` | How it ended: `timeout` / `app_close` / `reconciled`. | optional |

**Envelope fields this story leans on:** `session_id` on **every** event (so `sessions_before_purchase` and any member-matching works); `client_event_time`/`client_sent_time`/`server_received_time` → skew-corrected start/end; `event_id` → 24 h dedup against a resent close; `user_id` → sessions-per-user grain (whichever id is current at session end).

Note the key results-only property: start/end/duration arrive **pre-paired inside one terminal event**. The server never holds member events to reconstruct a session.

---

## 4. Data stored for longer-run processing

Per-game aggregates — **no new per-user structure**:

- **Per game × UTC-day (start-day grain):** `session_count` (incremented by start day) and `session_duration_sum_ms` (attributed by the split rule — a session contributes to at most two adjacent days). Average length is a read-time division; no stored average.
- **Per game × UTC-day:** a `sessions_touching` count (any-overlap) so the split-duration average has a coherent denominator. Equals `session_count` except for midnight-spanners.
- **Per game × window:** distinct-users-with-a-session and active-user-days → sessions-per-user and frequency.

**Per-user spine: reuse, do not add.** "Active on a day" is exactly the retention `active_days_bitmap` — the session's **start** UTC day is the offset whose bit is set. Active-user-days = popcount over that bitmap. Session counts/durations are per-game×day results, not per-user. This keeps session analytics off the per-user spine (honors SC-007).

**Distinct-user counting** over a window is the one non-trivial shape: **exact** per game×day distinct sets in v1 (affordable at indie scale); an approximate sketch (HyperLogLog) is the documented scale lever (approximate is fine for frequency, never for retention). Fully computable without raw re-scan. ✓

---

## 5. Data-structure thinking — Redis & database

*Conceptual shapes only.*

**Redis (transient, hot).**
- **Today's session counters** — per game × today: running `session_count` and `session_duration_sum_ms`, plus `sessions_touching`. Hot, fast, lost on crash (accepted).
- **Today's distinct-active-user set** — the set of `user_id`s that started a session today (feeds DAU/frequency and the union for windows).
- **The 24 h dedup window** — shared; a resent `session` event is caught here.

**Database (durable, results-only).**
- **Per-day session results** — durable `session_count` / `duration_sum` / `sessions_touching` per game × sealed-day.
- **Retained daily distinct-user sets** (or per-day sketches) — so WAU/MAU/sessions-per-user windows are a union over days.
- **The retention spine's `active_days_bitmap`** — *reused*, not duplicated; the session's start day sets the bit (owned by Phase 04, written from the session event).

**The bridge.** Hot per-day counters flush to durable per-day results on the periodic cadence (idempotent absolute upsert). The retention bit is durable in the spine once flushed — a Redis loss doesn't un-retain a user whose bit already flushed.

---

## 6. Configurations

| Knob | Default | Range | Forward / retro |
|---|---|---|---|
| `session_inactivity_timeout_min` | 30 | 1–240 | **Forward-only.** Lives in the SDK; decides boundaries at capture time. Already-emitted sessions and sealed-day aggregates keep their old boundaries — retroactively re-timing would need a forbidden raw re-scan and would mutate sealed aggregates. |
| `session_max_duration_cap_min` | 720 (12 h) | 1–1440 | **Forward-only.** Server-side sanity clamp on a stuck/unclosed session; applies to sessions processed after the change. |
| `session_min_duration_ms` | 0 | 0–60000 | **Forward-only.** Optional floor for single-event (0-duration) sessions, for average-length honesty. Default 0 = count as-is. |

**Inherited globals (referenced, not owned):** flush cadence 5 min, dedup window 24 h, day-seal grace 48 h, per-game reporting timezone offset (display-only — never re-buckets session days).

---

## Cross-references

- Deeper sheet: [`../metrics/05-sessions.md`](../metrics/05-sessions.md) — reconciliation (killed-app), sealed-boundary spanning, anon→identified mid-session, and open questions (§S-1 server-SDK sessions, §S-2 `sessions_before_purchase` as a client counter, §S-3 distinct-user exactness).
- **Blocks** Phase 04 (retention consumes the start-day activeness bit) and Phase 06 (DAU reuses the same activeness). Feeds Phase 05 (`sessions_before_purchase` is a client-SDK counter, not server-derived).
