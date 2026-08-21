# Session & Engagement Tracking — Design

**Date:** 2026-08-21
**Status:** Awaiting review
**Supersedes behaviour in:** [003-sessions](../../../specs/003-sessions/spec.md), [009-client-sdk](../../../specs/009-client-sdk/spec.md) §2.1

## 1. Why

Production reports session duration as zero. The cause is confirmed and is not a
backend defect:

- The SDK advances `last_activity` only inside `onCapture()`
  (`packages/sdk-client/src/session.ts:151`). There is no heartbeat and no
  visibility-driven bump.
- The live game (a Bale-Android WebView) emits one event per visit, so
  `last_activity === session_start_time`.
- `pagehide`/`visibilitychange` did not fire in that WebView, so the session fell
  through to reconcile-at-next-init, whose duration is by definition
  `last_activity − session_start_time` = 0.
- Decoded raw production event: `session_start_time === session_end_time`,
  `duration_ms: 0`, `reason: "reconciled"`. Reproduced against the real SDK — ten
  minutes of play returns 0.

Deriving time-present from the span between the first and last gameplay event
cannot work: a game that emits one event per visit has no span. Presence has to be
measured, not inferred.

A second, independent defect was found and fixed while investigating: the trusted-time
derivation future-clamped each endpoint separately, so a client whose clock led the
server silently lost exactly that lead from every session (commit `4db08a2`). That fix
is already in production and is unrelated to the model below.

## 2. The model

Adopt the GA4 split: **session boundary** and **engagement time** are separate
measurements that share a session id.

- **Session boundary** — when a session starts and ends. Governed *only* by the
  inactivity timeout. It never derives duration.
- **Engagement time** — how long the app was actually visible/foreground, accumulated
  by the SDK into `engagement_ms` and reported periodically.

The existing `duration_ms` / `duration_sum_ms` (wall-clock span from start to end)
stays as-is. Engagement is added beside it, not in place of it. They answer different
questions and will legitimately differ.

## 3. Decisions

Two decisions were delegated to the author. Both are recorded here with their
rationale so they can be overturned during review.

### 3.1 The wire carries a cumulative absolute, not a per-beat delta

**Chosen:** every heartbeat and the terminal event carry `engagement_ms` as the
*running total for that session so far*. The server converts absolute → delta against
per-session state.

Rationale — this is not a style preference, it is the difference between a number that
self-heals and one that silently drifts:

| | redelivered beat | dropped beat |
|---|---|---|
| per-beat delta | re-added (over-count) | **lost forever** |
| cumulative absolute | `max(0, abs − last)` = 0 | next beat recovers it |

A dropped beat is not hypothetical. The kernel claims the dedup marker *before* the
durable and hot steps (`ingest-kernel.ts:210`), so a worker whose lock expires between
claim and write has its retry short-circuit as a duplicate and never reach the hot
hook. Under a delta design that engagement is gone with no exception and no tally —
and a reported engagement that drifts monotonically low is indistinguishable from
players simply playing less. That failure is invisible, which is exactly the class of
bug this whole exercise exists to eliminate.

The cost is real and accepted: one small Redis key per live session, plus a Lua script.

### 3.2 Backgrounding no longer ends the session

**Chosen:** `visibilitychange → hidden` folds the engagement span and flushes, but does
not close the session. Only the inactivity timeout ends a session.

The current code (`client.ts:155`) calls `session.close('app_close')` on hidden, which
contradicts this repo's own normative spec ([009-client-sdk §2.1](../../../specs/009-client-sdk/spec.md):
"Backgrounding alone does **not** close a session"). The implementation, not the spec,
is the outlier.

**Operational consequence, stated up front:** today every background/foreground cycle
manufactures a new session, so N app-switches produce N+1 sessions for one play bout.
Fixing this makes production session counts **drop**. That is the inflation going away,
not a regression. It also lowers `sessions_before_purchase`, which is currently
inflated by the same mechanism.

## 4. Architecture

```
SDK
  foreground span ──beat every 30s──► engagement_ms (cumulative, persisted)
        │
   hidden  ──► fold span SYNCHRONOUSLY (before any await) ──► persist ──► flush
   visible ──► open new span; if persisted watermark gap > timeout, end old session
        │
        ▼
  heartbeat event (its own kind, NOT `session`)
        │
Server  ▼
  hot hook ──► ONE Lua EVAL, atomic:
                 delta = max(0, absolute − watermark)
                 delta = min(delta, wall-clock elapsed since session start)
                 if delta > 0: HINCRBY day hash, SET watermark, refresh TTL 72h
```

Four invariants hold the design together. Each exists because violating it produces a
silent wrong number:

1. **Accumulate, never subtract.** Engagement is the sum of clamped per-beat
   increments, never `last_present_at − span_start`. A WebView suspended overnight
   would otherwise credit ~8 hours of phantom presence.
2. **The heartbeat never touches the inactivity basis.** If a beat bumped
   `lastActivityMono`, sessions would become immortal and the boundary rule would
   silently stop working — the exact inversion the model forbids.
3. **The absolute → delta conversion is atomic.** The ingest worker maps a batch
   through `Promise.all`, and a client returning from background ships up to
   `batch_max_events` queued beats at once. Non-atomic read-modify-write means every
   one of them reads the same stale watermark and adds its full delta — an
   order-of-magnitude over-count on precisely the path this redesign targets. One Lua
   `EVAL` (Redis is single-threaded) removes the window. `balance-lww.service.ts:58`
   (`GUARDED_UPSERT_LUA`, applied at :133) is the house pattern to copy.
4. **The watermark is day-less.** Keyed `{game}:sess:eng:{session_id}`, never
   day-scoped. A day-scoped watermark resets at midnight, so the first post-midnight
   beat re-credits the session's entire pre-midnight engagement.

### 4.1 Why the heartbeat needs its own kind

It cannot be `kind=session`: `SessionHotHook` increments `session_count` and
`sessions_touching` unconditionally (`session-hot.hook.ts:85-86`) without inspecting
`envelope.name` or `props.reason`, so a 30 s beat on a 10-minute session reports ~20
sessions instead of 1 — and because the merge rule is `GREATEST`, that inflation is
monotonic and uncorrectable without a manual raw-file rebuild.

It cannot be `kind=generic` either: the dispatcher looks up story hooks by resolved
kind only (`kind-dispatch.ts:341`), so a generic event runs the cat/cnt/rank base and
stops, never reaching any session code.

It must therefore be a new registered kind with its own triple in
`SessionsModule.onModuleInit`. **It must not be *named* `session`** —
`RESERVED_NAME_KINDS` (`ingest-kernel.ts:63`) forces that name onto the strict typed
path regardless of declared kind, where it would quarantine for missing required props
and feed nothing.

The heartbeat registers a hot hook only. It performs **no durable spine writes** — no
`first_seen` seeding, no retention bit, no session counters. This also keeps its cost
far below the full session path, which makes 6–10 sequential round-trips per event.

## 5. Changes — SDK

`packages/sdk-client/src/session.ts`
- `OpenSessionRecord` gains `engaged_ms: number` and `last_present_at: number`.
- New in-memory fields: `engagedMs`, `spanStartMono`.
- `openSpan()` / `closeSpan()` — `closeSpan` folds
  `min(mono_now − spanStartMono, beatInterval × slack)` into `engagedMs`, and is
  idempotent via the `if (this.spanStartMono === undefined) return;` guard shape
  `endSession` already uses. Both `visibilitychange` and `pagehide` fire the same
  handler, so a non-idempotent fold double-counts the final span.
- `onHeartbeat()` — folds the current span, reopens it, persists `{engaged_ms,
  last_present_at}`. Single small KV write; no queue push (every capture already awaits
  ≥3 IndexedDB transactions on a Phaser main thread).
- New heartbeat timer via the already-injected `deps.setTimer`. **Not** the transport
  flush loop: that interval mutates to full-jitter backoff on failure, dies silently if
  `flush()` rejects, and keeps ticking after a 401 pause. It is a delivery loop, not a
  clock.
- `reconcile()` recovers the persisted `engaged_ms` and reports it on the terminal event.
- Engagement mutation happens with **no `await` between read and write** — persistence
  is a separate, later, best-effort step. Otherwise heartbeat and hidden-flush interleave
  across a storage await and lose or duplicate updates.

`packages/sdk-client/src/client.ts`
- `installLifecycleListeners` gains a `visible` branch and stops calling
  `session.close()` on hidden (§3.2).
- On `visible`: compare the persisted wall watermark to now; if the gap exceeds the
  inactivity timeout, end the old session and start fresh. This is what catches a
  suspended WebView whose monotonic clock froze.
- `dispose()` removes the listeners it installed (see §7).
- The hidden handler folds the span **before** its first `await` — `session.close()`
  currently awaits an IndexedDB commit before `unloadFlush()` even starts, and anything
  placed after those awaits is lost on the exact kill path this fixes.
- `emitTerminal` adds `engagement_ms` to the terminal event's props.
- New `emitHeartbeat` building the heartbeat envelope.

`packages/sdk-client/src/config.ts`
- `engagement_heartbeat_sec` knob, default 30, clamped (e.g. 10–300).

Values go on the wire as **JSON numbers, never strings**: `pii-scrub.service.ts:47`
rewrites any string containing a 9+ digit run to `[redacted:digits]` before the
validator sees it.

## 6. Changes — backend

| File | Change |
|---|---|
| `src/sessions/session-keys.ts` | `SESS_FIELD_ENGAGEMENT_SUM_MS`; day-less watermark key builder |
| `src/sessions/session-validator.ts` | `engagement_ms` as **optional** integer ≥ 0; new heartbeat kind validator |
| `src/sessions/session-hot.hook.ts` | Lua EVAL for absolute→delta→HINCRBY |
| `src/sessions/session-flush-plans.ts` | 4th `valueColumn`, rule `greatest`; projector entry |
| `src/sessions/session-floor.provider.ts` | 4th selected column, **coalesced to `'0'`** |
| `src/sessions/session-time.ts` | pure clamp: engagement ≤ wall-clock elapsed since start |
| `src/sessions/sessions.module.ts` | register the heartbeat kind triple (hot hook only) |
| `src/database/entities/session-day-result.entity.ts` | `engagementSumMs` |
| `src/database/migrations/1721300000030-AddSessionEngagement.ts` | new column |
| `src/sessions/session-read.service.ts` | expose engagement; strip logic |
| `src/panel/...` | new card (see §8) |

`engagement_ms` must be **optional**. The validator quarantines on any missing required
prop, and a quarantined record feeds nothing — making it required would stop every
session from the un-upgraded live WebView from counting at all.

Column is `bigint NOT NULL DEFAULT 0`. A nullable column reaching the floor provider
becomes the literal Redis string `"null"` via `HSETNX`, after which every `HINCRBY` on
that field fails with `ERR hash value is not an integer` and takes down the whole hot
hook for that day. That is the sharpest trap in this change.

Server-side clamp is mandatory: `engagement_ms` would be the first client-supplied
magnitude the session path ever writes, on a public `sdk_key` endpoint, into a
`GREATEST` column that can never go back down.

## 7. In-scope bug fixes

Approved for inclusion:

1. **CI gates.** `ci.yml` runs neither `npm run sdk:test` nor `migration:run`. The
   entire SDK — where this feature lives — is ungated on every PR, and entity/migration
   drift is structurally invisible because tests build the schema from entities with
   `synchronize: true`. Both steps get added.
2. **SDK listener leak.** `dispose()` never removes the `visibilitychange`/`pagehide`
   listeners. Proven: a disposed client still emits `app_close` on a later `pagehide`,
   and three clients in one test file all fire on one event. This must be fixed *before*
   the engagement tests are written, or the tests will encode the bug.
3. **`unloadFlush` ships the wrong end of the queue.** `transport.ts:271` peeks the
   *oldest* 400 rows. After an offline session with a deep backlog the terminal event —
   the one carrying final engagement — is exactly what gets left behind. Needs a tail
   selection.

## 8. Panel

Duration surfaces in exactly one place today: the "Avg duration" card on
`/panel/:gameId/sessions`, computed as `Σ duration_sum_ms / Σ sessions_touching` and
formatted by `fmtDuration` (0 → `"0m 0s"`, null → `"N/A"`). Because sessions exist, it
takes the zero branch — a confident wrong measurement.

Add an **Engagement time** card. The "not measured" state must be carried *in the data*
(a count of sessions that reported an engagement signal), never inferred from the value
being 0 at the formatter — otherwise a genuinely tiny engagement time becomes
indistinguishable from missing instrumentation.

Explicitly rejected: raising `session_min_duration_ms` to make the number look
plausible. It floors every session to a constant and poisons the durable cell
forward-only. It masks the bug rather than fixing it.

## 9. Edge cases

| Scenario | Handling | Residual |
|---|---|---|
| Hard kill, no lifecycle event | Persisted `engaged_ms` + watermark; reconcile recovers it | ≤ one heartbeat interval |
| Background/foreground cycling | Span fold on hidden, reopen on visible; idempotent fold | none |
| Timer throttled in background | Per-beat clamp bounds any single increment | ≤ clamp slack |
| OS suspend (monotonic frozen) | On visible, wall watermark gap > timeout ends the session | none |
| Offline whole session, late return | Absolute is self-healing; queued beats collapse to one delta | see below |
| Redelivered batch | `max(0, abs − watermark)` = 0 | none |
| Concurrent beats in one batch | Single Lua EVAL | none |
| Session spans midnight | Engagement credited to each beat's own corrected day | ≤ one beat at the boundary |
| Storage falls back to memory | Warn on the auto→memory fall-through; expose backend in `debugState()` | data still lost, but visibly |

Two accepted limitations, documented rather than fixed:

- **Midnight denominator.** Engagement is split by heartbeat cadence; `duration_sum_ms`
  is split geometrically by `durOnDay`. The two disagree at a day boundary by less than
  one heartbeat interval. A fully correct fix needs a per-(session, day) watermark the
  client cannot compute — a large protocol addition to correct an error smaller than one
  beat.
- **Seal grace.** Session events bypass the step-5 seal gate, so a device returning after
  the 48 h grace can still mutate a sealed day. This is pre-existing, affects
  `duration_sum_ms` today, and is **out of scope** here — flagged as a follow-up because
  the correct fix (re-checking seal state inside `SessionDurableHook.write`) changes
  existing session behaviour and deserves its own change.

## 10. Rollout order

Ordering is a correctness constraint, not a preference:

1. Migration + entity + merge-spec entry **ship atomically**. `buildFlushStatement` puts
   every declared `valueColumn` in the INSERT list, so a merge spec naming a column that
   Postgres lacks makes the statement throw — and then `session_count`,
   `duration_sum_ms` *and* `sessions_touching` all stop landing, not just engagement.
2. Floor provider extended in the same commit, or the first Redis loss silently stalls
   engagement with no error.
3. Server deploys before the SDK ships. `engagement_ms` is optional, so an old SDK keeps
   working against the new server; the reverse is not true.
4. Do not reuse a migration timestamp prefix. `1721300000030` is the next free slot.

Note for the deploy itself: the production host cannot reach Docker Hub, so the base
image must already be loaded. See the deploy procedure notes.

## 11. Tests

**SDK** (`packages/sdk-client/test/`) — the harness already has `FakeClock` with
separable wall/monotonic clocks, `FakeTimers`, and `MockIngest`, and jsdom can genuinely
dispatch `visibilitychange`/`pagehide`/`freeze`/`resume`.

- single-capture session, 10 minutes foreground → engagement ≈ 10 min *(this is the
  regression test for the original bug; a scratch repro already exists at
  `scratchpad/repro-single-capture-session.spec.ts`)*
- background/foreground cycle → one session, engagement excludes background time
- `hidden` + `pagehide` both firing → span folded exactly once
- hard kill mid-session → reconcile reports persisted engagement
- suspend (clock advances, timers do not fire) → session ends, no phantom engagement
- heartbeat never extends the inactivity boundary

Two harness gaps to close first: `FakeTimers` has no catch-up (one `advance(10min)`
fires a 30 s beat **once**, not 20 times — heartbeat tests must step in interval-sized
slices), and `MockIngest` can only return statuses, never reject, so "network loss" is
untestable until it can.

**Backend**

- absolute → delta conversion, including a redelivered beat → 0
- 20 concurrent beats for one session in one batch → correct total (the Lua atomicity test)
- watermark survives midnight without re-crediting
- clamp rejects an implausible client value
- heartbeat does **not** increment `session_count` / `sessions_touching`
- floor provider returns four fields after a Redis flush

**Caveat that invalidates green runs:** every session/retention integration case begins
`if (!redis || !ds) return;`, which Jest scores as a pass. Any end-to-end claim needs
explicit proof the stack was up.

## 12. Out of scope

- Seal-gate enforcement for session events (§9)
- Panel raw-UTC vs logical-day gating. Real but currently harmless at
  `REPORTING_OFFSET=0`. It **must** be fixed before the offset is ever changed to
  Tehran (+210), because `reporting_offset` is set-once and the day it flips is the day
  live data starts vanishing from the panel for 3.5 h every night.
- Wire-version dispatch for batches whose `v` exceeds server knowledge
