# Metric Spec Sheet: Sessions

**Feature**: 001-analytics-platform · **Phase**: research/specify · **Status**: Draft
**Depends on**: Locked decisions §B (retention — "active" = session), §D (monetization — `sessions_before_purchase`), §F (dedup), §G (event-time / UTC day-seal), §H (typed-kind validation). This sheet RESOLVES research.md §6 items §X-2 (session definition) and §B-1 ("active" = session). Retention, Monetization, Funnels, and derived-KPI sheets consume the SESSION_DECISION locked here.

## 1. Purpose & Definition

**Question answered**: How often and how long do players engage? Sessions are the atomic unit of engagement — they anchor retention ("active on a day" = a session that day), feed monetization context (`sessions_before_purchase`), and stand alone as engagement health (session count, average session length, sessions per user, session frequency).

**Locked session definition (this is the §X-2 resolution — all other sheets inherit it):**

- **Ownership — SDK-managed, not server-inferred.** The client SDK owns session lifecycle and mints `session_id`. Rejected: *server-inferred sessionization* (group a user's events by inactivity gap at ingest). Server-inferred is impossible under results-only storage — inferring a gap requires remembering a user's last-event-time across events, and reconstructing a session's full extent requires holding that user's raw events in the hot window, both forbidden. SDK-managed emits a single self-contained `session` fact, which is results-only-native. (Server-SDK events in v1 carry whatever `session_id` the game passes them, or none; the server SDK does not run its own inactivity timer in v1 — see §7.)
- **Start.** A session starts on the first tracked event after SDK init, or the first event after the previous session expired. The SDK generates a fresh `session_id` at that moment.
- **End.** A session ends when the inactivity timeout elapses with no tracked event (**default 30 min**), measured on **skew-corrected client-event-time** (§G) between consecutive events; OR on an explicit app-close/background signal if the platform provides one (Phaser `blur`/`visibilitychange`, React unmount/`pagehide`). Whichever fires first.
- **Why 30 min.** 30 min is the cross-industry default (GA4 default engagement session timeout, Adjust/GameAnalytics session convention). Shorter (e.g. 5 min) over-splits a player who reads a dialog or gets interrupted; longer (e.g. 60 min) merges genuinely distinct play bouts. Configurable per game (§3).
- **`session_id` generation.** Client-generated opaque id (UUID v4 or ULID), unique per `game_id`+`user_id`, minted client-side at session start. The server treats it as an opaque grouping key — never parses or validates its structure. ULID is preferred (embeds a client timestamp, aids offline debugging) but the server assumes nothing about the format.
- **What emits the `session` typed kind (the §B-1 anchor).** The SDK emits **exactly one** reserved `kind = session` typed event **at session end** (or at the next SDK init if the app was killed before flush — reconciliation, see §6). It carries `session_id`, `session_start_time`, `session_end_time`, `duration_ms`. **This single event is the sole thing that marks a user "active on a day" for retention** and the sole input to every session-analytics metric here. No other event kind sets the retention bit. (§B-1 resolved: default was "≥1 session event"; this locks it — the retention bit is driven by the session event's **start** UTC day.)
- **UTC-midnight-spanning — SPLIT for duration, START-day for counting.** Decided: a session that crosses UTC midnight is **counted once, in its start day** (so session count and the retention bit are write-once and never depend on when the session ends — preserving §B immutability and §G determinism), while its **duration is split pro-rata across each UTC day it overlaps** (so "total engaged time per day" is honest and a single all-night session doesn't dump 6h onto one day). Rejected: *count in end-day* (end-day isn't known at start, breaks write-once) and *count/attribute wholly to start-day incl. duration* (inflates the start day's engaged-time, distorts per-day average length). See §4 for the split formula and §6 for the sealed-boundary edge case.

## 2. SDK Data Captured

All fields ride the canonical envelope. This metric adds the reserved `session` typed kind. Every event already carries `session_id`; the fields below are the payload of the terminal `session` event only.

**Client-sent (the `session` typed event, `kind = session`):**

| Field | Meaning | Req/Opt | Source of truth |
|---|---|---|---|
| `session_id` | The session this event closes (matches the `session_id` stamped on that session's other events) | required | client SDK |
| `session_start_time` | First-event client-event-time of the session (skew-correctable) | required | client SDK |
| `session_end_time` | Last-event client-event-time, or inactivity-expiry / app-close time | required | client SDK |
| `duration_ms` | `session_end_time − session_start_time` in ms, computed client-side and re-derivable server-side from the two timestamps (server recomputes as the trusted value; client `duration_ms` is a convenience/sanity check) | required | derived; server recomputes |
| `reason` (optional) | How the session ended: `timeout` \| `app_close` \| `reconciled` (killed-app recovery) | optional | client SDK |

**Envelope fields this metric leans on (not redefined here):**
- `session_id` on **every** event — used to attribute `sessions_before_purchase` (§D) and to let a session-close event be matched to its session if ever needed; but note the metrics here need only the terminal `session` event, not the member events.
- `client_event_time` + `client_sent_time` + `server_received_time` → skew-corrected times (§G) applied to `session_start_time` / `session_end_time`.
- `event_id` on the `session` event → 24h dedup (§F) against a resent close event.
- `user_id` → sessions-per-user grain; whichever id is current at session end (anon or identified).

**Trust boundary.** Session data is **client-reported and spoofable** — this is accepted. Sessions are an engagement metric, not money (server-side is trusted only for money/economy). No server-side verification of duration in v1. A malicious client could inflate session length; at indie/solo-operator scale (not adversarial) this is out of scope. The server's only hardening is the sanity clamp on absurd durations (§6).

## 3. Admin Configuration

| Knob | Default | Range / values | Retro / forward |
|---|---|---|---|
| `session_inactivity_timeout_min` | 30 | 1–240 (minutes) | **Forward-only.** The timeout lives in the SDK and decides session boundaries at capture time; already-emitted `session` events (and any sealed day's session aggregates) keep their old boundaries. Changing it re-shapes only sessions started after the SDK picks up the new config. Justified: retroactively re-timing sealed sessions would require raw event re-scan (forbidden) and would mutate sealed aggregates (violates §G 48h-seal). |
| `session_max_duration_cap_min` | 720 (12h) | 1–1440 | **Forward-only.** Server-side sanity clamp: a `session` event whose `duration_ms` exceeds the cap is clamped to the cap (a stuck foreground tab / unclosed session). Affects only sessions processed after the change. |
| `session_min_duration_ms` (single-event floor) | 0 | 0–60000 | **Forward-only.** A session with exactly one event has `duration_ms = 0`; this optionally floors it (e.g. to a nominal 1s) for average-length honesty. Default 0 = count zero-length sessions as-is. |

*Inherited/global knobs referenced, not owned here:* Postgres flush cadence (5 min), dedup window (24h), day-seal grace (48h), per-game reporting timezone offset (display-only — never re-buckets session days, per §G-3).

## 4. Calculation

**Time-bucketing**: UTC day (§G), keyed by the session's **start** UTC day for count/frequency, and split across UTC days for duration (below). **Grain**: per `game_id` × UTC-day; sessions-per-user rolls up over a window; segment slices (level bucket, region) inherit from the session event's context props where present.

**Formulas (definitional):**

1. **Session count (per game × UTC day D):**
   `session_count(D) = | { session events whose session_start_time falls on UTC day D } |`
   (Count by **start day** → write-once, midnight-safe.)

2. **Total engaged duration (per game × UTC day D)** — with the midnight split:
   For each session s overlapping day D, its contribution is the wall-clock overlap of `[session_start_time, session_end_time]` with `[D 00:00Z, D+1 00:00Z)`:
   `dur_on_day(s, D) = max(0, min(end_s, D_end) − max(start_s, D_start))`
   `total_duration(D) = Σ_s dur_on_day(s, D)`
   A session entirely within one UTC day contributes its whole duration to that day; a midnight-spanning session contributes each side to the respective day.

3. **Average session length (per game × UTC day D):**
   `avg_session_length(D) = total_duration(D) / sessions_touching(D)`
   where `sessions_touching(D)` = count of sessions with any overlap on D. (Divide split-duration by the same split population so the average is coherent. Alternatively report `avg_by_start = Σ full-duration of sessions started on D / session_count(D)` — pick one and label it; default = the split form above for per-day engaged-time honesty.)

4. **Sessions per user (per game, over window W):**
   `sessions_per_user(W) = total_sessions_in_W / distinct_users_with_a_session_in_W`

5. **Session frequency (per game, over window W):**
   `session_frequency(W) = total_sessions_in_W / active_user_days_in_W`
   where an active user-day = a (user, UTC-day) pair with ≥1 session start. (Answers "how many sessions does an active player start on a day they play.")

**Immature/partial-window handling**: today's UTC day is provisional until the 48h seal (§G) — the current day's session count/duration is a live Redis figure and may still grow; mark "provisional" (§E-2). Frequency/per-user over a window that includes today inherits that provisionality.

**Worked numeric example** (one game, one player, made-up numbers; timeout = 30 min):

Player fires events (skew-corrected client times, UTC):
- 2026-07-15 23:40:00 — event A (first after init) → **session S1 starts**, `session_id = s1`.
- 2026-07-15 23:52:00 — event B (12 min later, < 30 min gap) → still S1.
- 2026-07-16 00:20:00 — event C (28 min after B, < 30 min) → still S1 (S1 now spans midnight).
- 2026-07-16 00:35:00 — event D (15 min after C) → still S1.
- *No event for 30 min* → **S1 ends** at `00:35:00` (last event; `reason = timeout`). SDK emits `session` event: `session_id=s1, start=07-15 23:40, end=07-16 00:35, duration_ms = 55·60·1000 = 3,300,000` (55 min).
- 2026-07-16 09:00:00 — event E → **session S2 starts**, `s2`.
- 2026-07-16 09:10:00 — event F → still S2.
- *No event 30 min* → **S2 ends** at `09:10`, duration = 10 min = 600,000 ms.

Results:
- **Session count**: S1 counts in its **start day 07-15** → `session_count(07-15) = 1`. S2 starts 07-16 → `session_count(07-16) = 1`. (S1 crossing midnight does **not** add to 07-16's count.)
- **Retention bit** (§B-1): S1's start UTC day = 07-15 → sets the user's day-offset bit for 07-15. S2's start = 07-16 → sets 07-16's bit. So this user is "active" on both 07-15 and 07-16 — driven purely by session-start days.
- **Duration split**:
  - S1 overlap with 07-15: `[23:40, 24:00)` = 20 min → `dur_on_day(S1, 07-15) = 20 min`.
  - S1 overlap with 07-16: `[00:00, 00:35)` = 35 min → `dur_on_day(S1, 07-16) = 35 min`. (20 + 35 = 55 = full duration ✓.)
  - S2 entirely in 07-16: 10 min.
  - `total_duration(07-15) = 20 min`; `total_duration(07-16) = 35 + 10 = 45 min`.
- **Average session length**:
  - `sessions_touching(07-15) = 1` → `avg(07-15) = 20 min`.
  - `sessions_touching(07-16) = 2` (S1 tail + S2) → `avg(07-16) = 45/2 = 22.5 min`.
- **Sessions per user** over window [07-15, 07-16]: total sessions = 2 (S1, S2 — count once each by start day), distinct users = 1 → `2 / 1 = 2.0`.
- **Session frequency** over the same window: active user-days = 2 (this user played on both days) → `2 sessions / 2 active-user-days = 1.0`.

## 5. Data-Shape Requirements  (WHAT must be derivable — NOT how it's stored)

**Incremental result shapes to maintain:**

- **Per `game_id` × UTC-day (start-day grain), we must be able to produce:** `session_count` (int, incremented at each session event by its start day) and `session_duration_sum_ms` **attributed by the split rule** (a session event contributes to at most two adjacent UTC-day duration accumulators). From these two, average-session-length is a pure division at read time — no separate stored average.
- **Per `game_id` × UTC-day, a "sessions_touching" count** (sessions with any overlap on the day) so the split-duration average has a coherent denominator. For non-spanning sessions this equals `session_count`; only midnight-spanning sessions make it differ, and each such session bumps the touching-count of two days.
- **Per `game_id` × window, distinct-users-with-a-session** and **active-user-days** — these power sessions-per-user and frequency. Distinct-user counting over an arbitrary window is the one non-trivial shape: at indie scale an exact per-day distinct-user set is affordable, but if it isn't, an approximate distinct-count sketch (e.g. HyperLogLog) per game×day is the documented lever (approximate is acceptable for frequency; §7). Active-user-days = the count of (user, day) pairs with a session, which the retention spine's `active_days_bitmap` already encodes per user (popcount) — reusable, no new per-user structure needed.

**Per-user-spine requirement (reuse, do not add):** the session metric needs **no new per-user durable structure**. "Active on a day" is exactly the existing retention `active_days_bitmap` (§B / FR-015/016) — the session event's **start** UTC day is the day-offset whose bit is set. Session **counts and durations** are per-game×day results (not per-user) and need no spine. This is deliberate: keeping session analytics off the per-user spine honors SC-007 (spine stays a handful of small columns).

**How duration is captured without raw events (the key results-only point):** the SDK emits the `session` event **already carrying start, end, and duration** — start/end are **not** two separate typed events the server must pair in the hot window; they arrive **pre-paired inside one terminal event**. The server never holds member events to reconstruct a session. Duration folds into per-day accumulators the instant the single `session` event is processed, via the split rule. Therefore: **fully computable from incremental results + the existing retention spine, with NO raw re-scan.** ✓ (This is why SDK-managed beats server-inferred — server-inferred would need the raw member events.)

## 6. Edge Cases & Failure Modes

- **App killed before session close (reconciliation).** If the app is force-quit, the terminal `session` event may never send. On next SDK init, the SDK detects an unclosed prior session (persisted locally) and emits it with `reason = reconciled`, `session_end_time` = last recorded event time, `duration_ms` from that. Late arrival is handled by §G: if the reconciled session's start day is still within the 48h grace it folds normally; if that day has **sealed**, the session event is **quarantined to the raw file** (§G/§H) — its count/duration are NOT folded into the sealed day, and its retention bit is **not** set (a small offline tail; matches §G "residual error"). This is the one case where a real session can miss the headline numbers; accepted.
- **Midnight-spanning session hitting a sealed boundary.** A long session starting in day D that ends after D has sealed: the **start-day count and retention bit** are safe (attributed at start, folded while D was still open — the session event arrives at end, so if the session is long enough that D sealed before end, the whole event lands post-seal and follows the quarantine rule above). Practically, a session must exceed the 48h grace to trigger this — rare. Documented, not specially handled.
- **Dedup (§F).** A resent `session` event (offline retry) is caught by `event_id` + 24h window → counted once. Beyond 24h a duplicate could double-count a session; accepted for non-money data (§F residual risk), same tradeoff as all generic/economy events. Sessions are **not** money — no durable `transaction_id`-style dedup.
- **Clock skew (§G).** `session_start_time` / `session_end_time` are skew-corrected. Sub-60s skew is trusted verbatim (dead-band) and only matters at a midnight boundary — a session's day-attribution could shift by the skew at exactly 23:59:xx. Accepted (§G tolerance). Future-dated session times clamp to server-now.
- **Negative / absurd duration.** If `session_end_time < session_start_time` (client clock ran backward mid-session), clamp `duration_ms` to 0. If `duration_ms > session_max_duration_cap_min` (§3, stuck tab), clamp to the cap before folding. Both are server-side sanity guards; neither drops the session (count still increments).
- **Single-event session.** `duration_ms = 0` (or floored by `session_min_duration_ms`). Still a valid session — increments count and sets the retention bit. Common for bounce/one-tap opens.
- **Redis loss (§E).** Current-day session counters live in Redis and are lost on crash (transient by design); durable per-day session results flushed ≤5 min ago (§E) survive, and the raw file (write-ahead) holds the day's `session` events as the manual rebuild floor. No automated replay (§E). The retention bit is durable in the spine once flushed, so a Redis loss doesn't un-retain a user whose bit already flushed.
- **Anon→identified mid-session.** `session_id` does **not** rotate on login (locked in SESSION_DECISION); the terminal `session` event carries whichever `user_id` is current at end. A session begun anon and finished identified counts once under the identified `user_id`. Anon↔user merge is out of scope (envelope) — pre-login-only sessions stay under the anon id and are not retro-merged in v1.

## 7. Open Questions

- **§X-2 — Session definition [RESOLVED HERE].** SDK-managed, 30-min inactivity timeout, single terminal `session` event, start-day counting with midnight duration-split, session_id stable across anon→identified. This sheet is the resolution; other sheets consume the SESSION_DECISION block.
- **§B-1 — "Active" = session-start [RESOLVED HERE].** The retention day-offset bit is set by the `session` event's **start** UTC day. Default confirmed and locked. *Recommendation for /plan: retention worker keys off session events only, ignoring generic/economy/purchase events for activeness.*
- **§S-1 — Server-SDK sessions [OPEN].** Server-authoritative events (verified purchases, server-granted currency) have no natural client session. Do they (a) inherit a `session_id` the game threads through, (b) carry none and be excluded from session analytics, or (c) get a synthetic server session? *Recommendation: (b) — server events carry the game-supplied `session_id` if available else none; they never start/close a session and never set a retention bit. Session analytics is a client-engagement metric in v1.*
- **§S-2 — `sessions_before_purchase` derivation [OPEN, spans §D].** Monetization wants `sessions_before_purchase` as a context dimension. With SDK-managed sessions, this is a **client-side counter** the SDK maintains (sessions since install for this user) and stamps onto the purchase context-companion event — NOT something the server derives (server has no per-user session history under results-only). *Recommendation: SDK maintains and sends `sessions_before_purchase`; server treats it as an opaque context dimension. Flag to the Monetization sheet.*
- **§S-3 — Distinct-user counting for sessions/user & frequency [LEANING].** Exact per-day distinct-user sets are affordable at indie scale but grow with DAU. *Default: exact per game×day distinct-user tracking in v1; approximate sketch (HyperLogLog) documented as the scale lever — approximate is acceptable for frequency, never for retention (which uses the exact bitmap).*
- **§S-4 — Average-length variant labelling [LEANING].** Split-duration average (`total_split_duration / sessions_touching_day`) vs whole-duration-by-start-day average. *Default: report the split form per day (engaged-time honesty), and expose the whole-session `avg_by_start` on a per-session-list/analytics view; label whichever the dashboard shows.*
- **§S-5 — Explicit app-close signal reliability [OPEN].** Browsers do not guarantee `pagehide`/`visibilitychange` fires (tab crash, OS kill). *Recommendation: treat inactivity-timeout as the authoritative close; app-close signal is an optimization that closes sooner when it does fire; reconciliation (§6) covers the rest.*
