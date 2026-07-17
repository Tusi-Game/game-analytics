# Phase 07 — Cold-Storage Lifecycle

**Feature**: 001-analytics-platform · **Story**: US5 (P3 — operational) · **Reserved kind owned**: none (ops) · **Status**: Draft
**Depends on**: Phase 01 (the raw event stream workers append). Read anytime after 01.
**Deeper reference**: no dedicated metric sheet — this is an operational story. **Spec**: US5, FR-023/024, SC-010, and the Redis-loss / write-ahead Edge Cases.
**Excluded here** (→ later per-phase design): file format, compression codec, S3 client, scheduler, key layouts.

---

## 1. Story understanding

**The story.** Raw events are appended to a per-game **daily file**; a nightly job uploads yesterday's file to S3-compatible storage, then deletes it locally — all configurable — so the operator keeps a disposable backup / backfill escape hatch without paying for long-term hot storage.

**The question it answers.** *Where does the raw truth go, and how do we keep it cheap and disposable?* The platform stores only processed results in the database (never raw logs); the raw stream still has to land *somewhere* durable-enough to be the **manual rebuild floor** and a theoretical backfill source — but nowhere expensive or permanent.

**What it means for the operator.** A per-game gzip file per day, shipped nightly to any S3-compatible target (MinIO / Arvan / etc. — works under network restrictions), then removed from local disk. Losing a day's raw file or the Redis cache is explicitly acceptable; losing durable database results is not. The pipeline works fully **without** this phase — it is the disposable safety net, not a metric.

**The load-bearing invariant it upholds (§E write-ahead).** A worker appends the raw file (fsync'd, if cold storage is on) **before** updating any counter. This makes the raw file a **complete superset** of anything counted — so no event is ever counted-but-unlogged (SC-008), and the file is a valid rebuild floor. Getting the order wrong (counter-first) would create counted-but-never-logged events. This ordering is owned by the pipeline (Phase 01's workers); this phase owns the file's **lifecycle** after it's written.

**Also the quarantine floor.** Typed-kind events that fail strict validation, and valid events arriving after their day sealed, are **quarantined to the raw file** (the dead-letter floor) rather than folded into aggregates — so the raw file is also where recoverable-but-excluded events live.

---

## 2. How it is calculated

This is a **lifecycle**, not a metric — no formula. The state machine per game per day:

```
DURING DAY d      → append each processed raw event (write-ahead, fsync'd) to the game's day-d file (compressed)
                    [+ append quarantined typed-invalid / sealed-late events to the same file's quarantine tail]
NIGHTLY JOB       → for each game, take yesterday's (day d) completed file:
                       1. upload to the configured S3-compatible bucket
                       2. on confirmed upload → delete the local file
                    (respects config: enable/disable, bucket, credentials, retention)
IF cold storage OFF → no raw file is written at all
```

### Worked example

Game `g=42`, cold storage enabled, bucket `analytics-cold`, local retention 0 days (delete right after upload).

- **During 2026-07-16 (UTC):** workers append every accepted raw event for `g=42` — write-ahead, before counters — into `g42/2026-07-16.log.gz`. The 5 malformed `economy` events from the Phase 01 example also land here (quarantine tail). By midnight the file is a complete superset of everything counted that day.
- **Nightly job (early 2026-07-17):** yesterday's file `g42/2026-07-16.log.gz` exists → uploaded to `analytics-cold`; on confirmed upload it is **deleted locally**. `g42/2026-07-17.log.gz` (today) is untouched — still being appended.
- **If cold storage were disabled:** no `g42/2026-07-16.log.gz` is ever written; counters still update (but the write-ahead superset guarantee is waived — the operator has accepted no rebuild floor).

There is nothing to hand-verify numerically; the acceptance test is behavioral (SC-010): a file is written, uploaded, deleted, and every config toggle is honored.

---

## 3. Data needed (input)

This phase consumes the **same raw event stream** Phase 01 ingests — it adds **no new SDK field**. What it needs is not from the SDK but from the pipeline and config:

- **The processed raw event** (the full envelope + payload) as it passes through a worker — appended verbatim to the day file. This is the one place the *raw* form is written down.
- **The event's `game_id` and corrected UTC day** — to route it to the correct per-game daily file.
- **Quarantine-flagged events** — typed-invalid or sealed-late events the metric phases refuse — routed to the same file's quarantine tail.
- **Operator config** (below) — enable/disable, bucket, credentials, retention.

---

## 4. Data stored for longer-run processing

Cold storage is deliberately the phase that stores **the most and keeps it the least**:

- **Per-game daily raw file (cold, disposable):** a compressed append log of the day's raw events (+ quarantine tail). Local only until the nightly upload, then **deleted locally** and living only in S3-compatible storage. Not queried by any dashboard; it is the manual rebuild / backfill floor.
- **No database rows.** This phase writes **nothing** durable to the results database — that would violate results-only (FR-010). The database never holds raw events; the file is the only raw form and it is explicitly disposable.
- **Optional operational bookkeeping** — the nightly job may keep a small durable record of "which day-files uploaded successfully" for idempotency/observability, but that is operational metadata, not events or metrics.

The whole point: raw truth is voluminous, so it is kept **off the hot path and out of the database**, compressed, shipped, and deleted — the opposite storage posture from every metric phase.

---

## 5. Data-structure thinking — Redis & database

*Conceptual shapes only.*

**Redis (transient).**
- **No cold-storage state in Redis.** Redis holds the queue + hot counters (Phase 01); the raw file is written to **local disk** by the worker, not to Redis. The only interaction is *ordering*: the fsync'd file append happens **before** the Redis counter update (write-ahead), so a Redis loss never leaves a counted-but-unlogged event.

**Filesystem (local, transient) → object storage (cold, durable-cheap).**
- **Local disk:** one open append file per game per current day (compressed). Today's file is being written; yesterday's is a completed candidate for upload.
- **S3-compatible object storage:** the destination — one object per game per day. This is the durable-but-cheap resting place; not hot, not queried, disposable.

**Database (durable, results-only).**
- **Nothing raw.** At most the optional upload-bookkeeping record noted in §4. The database's role in this story is to be the place raw events **never** go.

**The bridge.** Worker → **fsync local file append (write-ahead)** → then Redis counter → (periodic) → database results. Separately, the **nightly job** moves completed local files → object storage → deletes local. Two independent flows: the per-event write-ahead append (durability floor) and the once-a-day file shipment (cost control).

---

## 6. Configurations

| Knob | Default | Range / values | Forward / retro |
|---|---|---|---|
| `cold_storage_enabled` | on | on / off | **Forward-only** — turning it off stops new raw files being written; already-uploaded files are untouched. Turning it on begins writing from that point (no backfill of days that ran with it off). |
| `cold_storage_bucket` | operator-set | S3-compatible bucket name | Applies to uploads from the change forward; past uploads stay where they landed. |
| `cold_storage_credentials` | operator-set | endpoint + key/secret (any S3-compatible provider) | Applies forward. |
| `cold_storage_local_retention_days` | 0 | 0–N days | How long the local file is kept **after** a confirmed upload before deletion. 0 = delete right after upload. Forward-only. |
| `cold_storage_upload_schedule` | nightly | cron-like cadence | When the upload job runs; applies forward. |
| `raw_file_compression` | on (gzip) | on / off / codec | **Forward-only** — a codec change applies to newly-written files; existing files keep their codec. |

**Inherited globals (referenced):** the write-ahead ordering and 48 h day-seal / quarantine rules are pipeline invariants (owned by Phase 01 / §E / §G), not cold-storage knobs — cold storage honors them but does not define them. All operational choices here are **configurable so the operator can change strategy without code changes** (FR-027).

---

## Cross-references

- No metric sheet (operational story). Grounded in `../spec.md`: US5, FR-023/024, SC-010, and the Redis-loss / write-ahead / quarantine Edge Cases.
- **Upholds the durability invariant** every metric phase relies on (write-ahead raw append → complete superset → SC-008). Consumes Phase 01's raw stream and the quarantine tails of Phases 03 / 04 / 05 (typed-invalid and sealed-late events).
- **Future escape hatch:** the raw file is the theoretical source for the deferred "rebuild dimensions forward from raw" backfill and the manual raw-file rebuild runbook (research §X-1) — neither shipped in v1.
