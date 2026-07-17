# Phase 07 — Implementation Tasks: Cold-Storage Lifecycle
**Source spec:** `spec.md` US5, FR-023/FR-024, SC-010, FR-010, FR-027 · **Design deps:** `phases/07-cold-storage.md` (§Design), `phases/01.5-raw-file-contract.md` (normative append/lifecycle contract), `phases/00-foundation.md` (§1.2, §2.3, §3.1 step 4, §4.7, §5, §6), `phases/00.5-ops-envelope.md` (§7.3 erasure-refilter + `raw_retention_days`, §8 PITR S3-target sharing, §9 envelope-encrypted credentials) · **Status:** task-list draft (2026-07-17)

## 0. Scope & dependencies

This phase builds the **lifecycle of the raw day-file after it is written**: the nightly BullMQ shipment job (enumerate sealed-unshipped files → upload → verify → record → retention-delete), the `UPLOAD_BOOKKEEPING` operational table, the S3-compatible client (MinIO/Arvan), the config toggle surface (`GAME.config`), the retention-bounded local delete, and the ops read-model (upload status per game×day). It also pins how the erasure ledger's rebuild-filter interacts with shipped raw files. **This phase does NOT write the raw file** — the fsync'd write-ahead append at Foundation §3.1 step 4 is *executed* by Phase 01's ingest workers (owned as a contract here, but implemented in 01, per bridge 01.5 §1). 07 owns file *semantics + lifecycle*; it never touches an open file.

**Must exist before this phase starts** (per `phases/README.md` dep table — 07 depends on 01, read anytime after): Phase 01's ingest worker path (the raw stream + step-4 append that produces the local day files 07 ships); `GAME.config` (Foundation §1.2, written by 01's registration/admin API); the seal clock (Foundation §2.3/§4.3/§4.7). The two flows are independent — 07's nightly job never runs in-line with the append.

**FR/SC this phase is accountable for:** FR-023 (append raw events to per-game daily compressed files *when enabled* — the contract 07 owns, 01 executes), FR-024 (nightly upload of the completed file to S3-compatible target + local delete, all configurable), SC-010 (nightly job uploads prior completed file, removes locally, honors every toggle), FR-010/SC-007 (nothing raw in Postgres — only `UPLOAD_BOOKKEEPING` metadata), FR-027 (all knobs configurable without code changes), and the SC-008 superset guarantee that this phase *defines* and 01 realizes (bridge 01.5 §8). Retention-bounded raw expiry interacts with 00.5's `raw_retention_days` (§7.3) and PITR's shared S3 target (00.5 §8, FR-028 — Foundation-owned, noted here for target reuse).

---

## 1. Task list

### Schema (Postgres — `UPLOAD_BOOKKEEPING`, direct-write, owner 07)

- [ ] **T-07.1** Define the `UPLOAD_BOOKKEEPING` table with key attributes `game_id` (PK, FK→`GAME`) and `utc_day` (PK), plus `uploaded_at`, `object_ref`, `integrity_ref`, `local_deleted_at` (nullable) — *cite:* Foundation §1.2 skeleton + 07 §Design ER table (adds `integrity_ref`/`local_deleted_at` beyond the §1.2 sketch). Presence of a row = "object verified in bucket"; **no status enum** (07 §Design: absence = not-yet-shipped). ≤ 1 row per game×corrected-UTC-day.
- [ ] **T-07.2** Establish that `utc_day` is the **corrected logical day** (Foundation §4.7 `logical_day(corrected)`), matching the file's seal-day key — never raw UTC, never arrival day — *cite:* Foundation §4.7, 07 §Design ("corrected-UTC-day file"), bridge 01.5 §2 routing.
- [ ] **T-07.3** Confirm no raw/event columns exist on any Postgres entity for this phase (this table holds file metadata only) — *cite:* FR-010, 07 §4 ("No database rows"), 07 §Design ("zero raw rows"). Verification gate, not a build step.
- [ ] **T-07.4** Note for `/plan`: `object_ref` deterministic scheme (one object per game per day) and `integrity_ref` shape (size + checksum + end-to-end-decode result) are logical refs, not a format spec — DDL column types deferred to `/plan` (below the no-DDL altitude) — *cite:* 07 §Design ("logical ref, not a format spec"), bridge 01.5 §4 seal-time integrity.

### S3-compatible client + config decrypt

- [ ] **T-07.5** Select/wrap an S3-compatible client that targets any endpoint (MinIO / Arvan / generic S3), driven by `cold_storage_credentials` (endpoint + key/secret) — must work under network restrictions (no hard AWS dependency) — *cite:* 07 §6 (`cold_storage_credentials`), 07 §1 ("any S3-compatible target — works under network restrictions"), stack (S3-compatible MinIO/Arvan).
- [ ] **T-07.6** Decrypt `cold_storage_credentials` **in-worker only** via the out-of-DB master key (env var / Docker secret / file mount) — never read plaintext from `GAME.config` — *cite:* Foundation §1.2 (reversible secrets envelope-encrypted, key outside Postgres), 00.5 §9 (envelope-encryption normative), FR-029.
- [ ] **T-07.7** Implement idempotent object PUT at the deterministic `object_ref` — a re-PUT to the same ref is a full overwrite (S3-compatible objects are immutable/PUT-replace), so an overlapping/retried upload is overwrite-idempotent — *cite:* bridge 01.5 §6 (S3 immutability, "PUT = full replace"), 07 §Design idempotency posture.

### Nightly shipment job (BullMQ scheduled — flow (b))

- [ ] **T-07.8** Register one BullMQ **repeatable** job on `cold_storage_upload_schedule` (default nightly, cron-like) — the only scheduling state; losing it merely re-registers the schedule — *cite:* 07 §6 (`cold_storage_upload_schedule`), 07 §Design Redis table ("BullMQ repeatable job… the only scheduling state").
- [ ] **T-07.9** **Enumerate step:** select local day files that are `COMPLETE` (`now ≥ seal(D) = D_end + 48 h`, using the logical-day seal clock) **AND** have **no** `UPLOAD_BOOKKEEPING` row — state-derived eligibility, per game, per file — *cite:* 07 §Design flow (b).1, bridge 01.5 §6, Foundation §2.3/§4.3 seal, §4.7 `D_end`. **Upload-eligibility = sealed file, NOT literal "yesterday"** (Q4 resolved — see T-07.24 / §4).
- [ ] **T-07.10** Ensure enumeration is **catch-up safe**: a missed run (downtime / schedule loss) picks up *every* sealed-unshipped day, not just the most recent — because eligibility is state-derived, never cursor-derived — *cite:* 07 §Design flow (b) ("Missed run… catch-up is automatic"), Redis table (job-lock/cursor rationale).
- [ ] **T-07.11** **Per-file isolation:** each game×file is uploaded independently; one file's failure never blocks the rest of the run — *cite:* 07 §Design flow (b) ("per-file isolation, one failure never blocks the rest").
- [ ] **T-07.12** **Upload step:** PUT the completed file to `cold_storage_bucket` (per decrypted credentials) at the deterministic `object_ref` — one object per game per day — *cite:* 07 §Design flow (b).2, 07 §6 (`cold_storage_bucket`).
- [ ] **T-07.13** **Verify step:** confirm the stored object against the local file's `integrity_ref` (size/checksum read-back) **before** recording — *cite:* 07 §Design flow (b).3, bridge 01.5 §4 seal-time integrity.
- [ ] **T-07.14** **Record step (verify-then-record):** insert the `UPLOAD_BOOKKEEPING` row only *after* successful verify — "an upload does not exist until the row does" — direct-write path (Foundation §5) — *cite:* 07 §Design flow (b).4, Foundation §5 (`UPLOAD_BOOKKEEPING` path "direct").
- [ ] **T-07.15** Consume Phase 01's **seal-time end-to-end decode check**: a file that fails full multi-member decode at seal is flagged (via `integrity_ref`) for operator attention and **not shipped** as a valid rebuild floor — *cite:* bridge 01.5 §4 ("verifies the file decodes end-to-end… not shipped as a valid rebuild floor"). (The decode check runs on the seal path; 07's job honors its verdict.)

### Retention-bounded local delete (flow (b).5)

- [ ] **T-07.16** **Retention pass:** delete local files whose `UPLOAD_BOOKKEEPING` row satisfies `now ≥ uploaded_at + cold_storage_local_retention_days` (default 0 = same run); stamp `local_deleted_at` — *cite:* 07 §6 (`cold_storage_local_retention_days`, default 0), 07 §Design flow (b).5.
- [ ] **T-07.17** Enforce the hard rule: **a local file is never deleted without a verified `UPLOAD_BOOKKEEPING` row** — *cite:* 07 §Design flow (b).5, bridge 01.5 §6 ("never without a verified row"), bridge 01.5 conformance checklist.

### Idempotency & failure posture

- [ ] **T-07.18** Make re-runs a **no-op for shipped days** (row present ⇒ skipped at enumerate step 1); an overlapping run at worst re-uploads to the same `object_ref` (overwrite-idempotent) — *cite:* 07 §Design ("Re-run = no-op"), bridge 01.5 §10.
- [ ] **T-07.19** Handle **partial upload** (crash mid-upload/verify): no row written ⇒ next run re-uploads from scratch to the same ref; **no partial-object state is ever recorded** — *cite:* 07 §Design ("Partial upload"), bridge 01.5 §10.
- [ ] **T-07.20** Handle **persistent failure** (bad credentials/bucket): files accumulate in `COMPLETE`, local disk grows, surfaced via the ops read-model — no DB-side data-loss mode; no retry-backoff state persisted beyond BullMQ — *cite:* 07 §Design ("Persistent failure"), 07 §Design Redis table (no upload counters/rate state).

### Config surface (`GAME.config`, forward-only — FR-027)

- [ ] **T-07.21** Add the six §6 knobs to `GAME.config` (read by 07's job, written by 01/10's admin API): `cold_storage_enabled` (on/off), `cold_storage_bucket`, `cold_storage_credentials`, `cold_storage_local_retention_days` (0–N), `cold_storage_upload_schedule` (cron-like), `raw_file_compression` (on/off/codec) — all **forward-only** — *cite:* 07 §6 table, FR-027, 07 §Design API surface. (`cold_storage_bucket`/`credentials` are platform-level defaults with per-game override; enable/disable, retention, schedule, codec are per-game.)
- [ ] **T-07.22** Wire `cold_storage_enabled = off` so the whole lifecycle is a **no-op**: no file, no upload, no bookkeeping. Toggle is forward-only — on-mid-day starts a partial file (ships normally); off-mid-day stops appends but an already-open file **completes its normal lifecycle** (seal → upload → delete) — *cite:* bridge 01.5 §7, 07 §Design flow (a) "Cold storage OFF" row + §6 forward/retro column. (The append no-op lives in 01's step 4; 07 ensures the *job* also no-ops for off games with no file.)
- [ ] **T-07.23** Add `raw_retention_days` (default 90; distinct from `cold_storage_local_retention_days`) to `GAME.config` and implement **S3-side raw expiry** for shipped objects — *cite:* 00.5 §7.3 + §7.7 (`raw_retention_days`, "joins 07's lifecycle — S3-side expiry"). Note: default 90; an operator wanting strict GDPR sets ≤ 30 (00.5 §9 tightening). Prefer bucket lifecycle rules where the S3 target supports them; else a scheduled expiry sweep.

### Ops read-model (dashboard API, PG-direct — derived, never stored)

- [ ] **T-07.24** Build the **upload-status read-model** per game×day, derived at read time from `UPLOAD_BOOKKEEPING` ⨝ file-lifecycle state — statuses: `n/a` (off, or no events → no file) · `open` (day unsealed) · `pending` (sealed, no row — includes retrying failures) · `uploaded` (row present, local within retention) · `local-deleted` (row + `local_deleted_at`) — *cite:* 07 §Design API surface (ops read-model). **No Redis merge** (Foundation §3.3's merge is for result cells only — this is operational metadata).

### Erasure-ledger interaction with shipped raw files

- [ ] **T-07.25** Document + enforce that shipped raw objects are **never rewritten on the hot path** — the erasure posture for raw files is **retention-bounded expiry** (`raw_retention_days`, T-07.23) + a rebuild-filter, not per-erasure object mutation — *cite:* 00.5 §7.3 (tier (c)), bridge 01.5 §6 immutability. This is what keeps the 01→07 handoff lock-free while remaining GDPR-defensible ("put beyond use").
- [ ] **T-07.26** Pin the **rebuild-filter obligation** into the manual rebuild contract: every raw rebuild MUST re-apply the `ERASURE_LEDGER` as a filter step (per replayed envelope: compute the per-game keyed hash of `user_id`, skip on match with an `executed` ledger row) — alongside re-dedup and logical-day flooring — *cite:* bridge 01.5 §5.1 step 4, 00.5 §7.3 ("every manual raw rebuild MUST re-apply the `ERASURE_LEDGER`"). 07 owns the file lifecycle these rebuilds read; the filter is normative for any tool that reads a 07-shipped object. (Rebuild tool build is deferred — this task records the contract, not the tool.)
- [ ] **T-07.27** Note the **optional strict mode** (`strict_raw_rewrite`, default off): an operator-run *offline* per-day tool — filter → write new object → verify → swap `object_ref` in `UPLOAD_BOOKKEEPING` → delete old object (replace-not-append, so 01.5 immutability holds) — *cite:* 00.5 §7.3 (tier (c) strict mode) + §7.7. Never on the hot path, never default; specified to exist (00.5 §9). Swapping `object_ref` is the one sanctioned 07-side write to a bookkeeping row post-upload.

### PITR shared-target note (Foundation-owned; coordination only)

- [ ] **T-07.28** Coordinate the S3-compatible **target reuse**: Postgres PITR (FR-028 / 00.5 §8) ships base backups + WAL to the *same* S3-compatible target already configured for cold storage — ensure bucket/prefix separation so raw day-files and PG backups don't collide, and that `raw_retention_days` expiry never touches PG-backup objects — *cite:* 00.5 §8 ("the same S3-compatible target already in the stack"), FR-028. **PITR itself is Foundation/ops-owned, NOT built here** — this task is only the shared-target boundary 07 must respect.

### Tests (behavioral — SC-010 is a behavioral test, no numeric verification)

- [ ] **T-07.29** Test the happy path: a completed (sealed) file → uploaded to the configured bucket → verified → `UPLOAD_BOOKKEEPING` row inserted → local file deleted per retention — against a local MinIO — *cite:* SC-010, 07 §2 ("a file is written, uploaded, deleted, and every config toggle is honored").
- [ ] **T-07.30** Test each **config toggle** is honored: `cold_storage_enabled` off ⇒ nothing shipped; `cold_storage_bucket`/`credentials` routing; `cold_storage_local_retention_days` > 0 defers delete; `cold_storage_upload_schedule` cadence; `raw_file_compression` codec preserved per-file — *cite:* SC-010 ("respecting all config toggles"), FR-024, 07 §6.
- [ ] **T-07.31** Test the failure interleavings from bridge 01.5 §10: crash mid-upload/verify ⇒ no row ⇒ next run re-uploads to same ref; local file lost pre-upload ⇒ that day's floor gone, results intact; sealed-late arrival never mutates a shipped object — *cite:* bridge 01.5 §10 failure table, Foundation §6 loss ledger.
- [ ] **T-07.32** Test **catch-up**: skip N nightly runs, then one run ships *all* sealed-unshipped days (not just the last) — *cite:* 07 §Design flow (b) ("Missed run… catch-up is automatic"), T-07.10.
- [ ] **T-07.33** Test **verify-then-record ordering**: a local file is never deleted, and no row exists, until verify succeeds — inject a verify failure and assert the file survives with no row — *cite:* bridge 01.5 conformance checklist ("verify-then-record; delete only after a verified row"), T-07.14/T-07.17.
- [ ] **T-07.34** Run the bridge 01.5 §11 conformance checklist items 07 owns: job selects sealed ∧ unbookkept (state-derived, catch-up safe); cold-off ⇒ job no-op; no code path rewrites a `COMPLETE`/`UPLOADED` file; rebuild-filter re-applies `ERASURE_LEDGER` — *cite:* bridge 01.5 §11.

---

## 2. Cross-phase dependencies

- **Needs the raw day-file to exist (Phase 01 executes the write-ahead append).** Foundation §5: the raw day file is **written by Phase 01's ingest workers at step 4**; 07 owns the *lifecycle* only. 07's nightly job cannot ship a file 01 never wrote. Before T-07.9 (enumerate) can run, 01's step-4 append must be producing local files. *07 READS local filesystem state; 01 WRITES the file.* (Bridge 01.5 §1 ownership split — normative.)
- **Needs the seal clock (Foundation §2.3/§4.3/§4.7).** T-07.9's eligibility (`now ≥ D_end + 48 h`) depends on the logical-day seal boundary (Foundation §4.7 `logical_day`, §2.3 seal). 07 READS this clock; it does not define it (owned by Foundation/§G, honored by 01's day-bucket machinery).
- **Needs `GAME.config` (Foundation §1.2; written by 01/Phase 10 admin API).** The six §6 knobs + `raw_retention_days` live in `GAME.config`. 07 READS config; 01 (registration) / Phase 10 (admin) WRITE it. T-07.21–T-07.23 cannot be exercised until the config surface exists.
- **Needs the out-of-DB master key (00.5 §9 / Phase 10 secret handling).** T-07.6 decrypts `cold_storage_credentials` with the envelope-encryption master key held outside Postgres; the key-provisioning mechanism is 00.5/Phase-10 territory. 07 READS the decrypted secret in-worker.
- **`ERASURE_LEDGER` is owned by 00.5 / Phase 10** (the erasure job writes `executed` rows). T-07.26's rebuild-filter READS `ERASURE_LEDGER` — 07 never writes it. The rebuild *tool* is deferred; 07 only pins the contract that any reader of a shipped object honors the ledger.
- **Shares the S3 target with Postgres PITR (Foundation/ops, FR-028 / 00.5 §8).** T-07.28: bucket/prefix boundary must be coordinated so PITR objects and raw day-files coexist; PITR is NOT built in this phase.
- **Ownership-matrix summary (Foundation §5):** 07 **WRITES** `UPLOAD_BOOKKEEPING` (direct) via the nightly job, and owns the raw-file lifecycle (disk→S3→delete). 07 **WRITES no structure owned elsewhere** (quarantine/sealed-late *tallies* ride `EXCEPTION_TALLY`, owned+written by 01). 07 **READS** `GAME.config`, local filesystem state, the seal clock, and (for rebuilds) `ERASURE_LEDGER`.

---

## 3. Acceptance & test mapping

| SC / FR | Satisfying task(s) | Verification |
|---|---|---|
| **FR-023** (append raw to per-game daily compressed files *when enabled*) | Contract owned here (T-07.15, T-07.22, T-07.25); **executed by Phase 01** step 4 | 07 verifies the file it ships is a valid gzip multi-member rebuild floor (seal-time decode, T-07.15); append itself tested in 01. Bridge 01.5 §8 SC-008 statement. |
| **FR-024** (nightly upload of yesterday's file to S3-compatible target + local delete, all configurable) | T-07.8–T-07.17 (job), T-07.21–T-07.22 (config), T-07.29–T-07.30 (tests) | Behavioral: file uploaded, verified, deleted; every toggle honored (T-07.30). "Yesterday" read as "most recent sealed file" (Q4, §4). |
| **SC-010** (nightly job uploads prior completed file, removes locally, respects all toggles) | T-07.8–T-07.17, T-07.21–T-07.24, T-07.29–T-07.34 | 07 §2: behavioral acceptance — write→upload→delete + toggle honoring. Independent test = T-07.29 (happy path against MinIO) + T-07.30 (toggles) + T-07.34 (conformance checklist). |
| **FR-010 / SC-007** (no raw in Postgres — only metadata) | T-07.1, T-07.3 (`UPLOAD_BOOKKEEPING` is file-metadata only) | Verify schema holds zero event/raw columns (T-07.3 gate); Postgres confirmed to hold no raw logs (spec.md acceptance checklist SC-007). |
| **FR-027** (all operational choices configurable, no code changes) | T-07.21 (six §6 knobs), T-07.23 (`raw_retention_days`) | T-07.30 exercises each knob; all forward-only per §6 table. |
| **SC-008** (write-ahead superset; no counted-but-unlogged event) | Defined here (bridge 01.5 §8 statement); T-07.15 (ship only a valid decoding floor), T-07.25 (immutability) | 07 *defines* the superset guarantee; 01 *realizes* it. 07's contribution: never ship a broken floor, never mutate a shipped object. spec.md acceptance: SC-008 verified via write-ahead ordering. |
| **FR-028** (PITR to S3 target) — *Foundation-owned* | T-07.28 (shared-target boundary only) | 07 ensures bucket/prefix separation; PITR restore-test is Foundation/ops (00.5 §8), not verified here. |
| GDPR raw-file erasure (00.5 §7.3, tier c) | T-07.23 (retention expiry), T-07.25–T-07.27 (rebuild-filter + strict mode) | Rebuild-filter re-applies `ERASURE_LEDGER` (bridge 01.5 §11 checklist item); `raw_retention_days ≤ 30` = strict physical erasure. |

---

## 4. Open considerations / flags for /plan

- **Upload-eligibility = seal, not literal "yesterday" (Q4 — RESOLVED, ratified 2026-07-17, not a redesign).** US5/SC-010 phrase the job as shipping "yesterday's" file, but corrected-day routing + the 48 h grace mean day D's file legally receives body appends until `D_end + 48 h`; a file is upload-eligible **at seal** (`run_day − 3` under the default 48 h grace). This is locked (bridge 01.5 §6, 07 §Design). **Flag for /plan:** SC-010's literal wording and the implemented behavior differ — the acceptance test must assert *"most recent **sealed** file"*, not *"literal previous-calendar-day file"*, or an operator/test author reading SC-010 verbatim will file a false bug. An operator insisting on literal-yesterday must set grace = 0 (a spec change, not a design change).
- **`object_ref` scheme + `integrity_ref` shape are below the no-DDL altitude (T-07.4).** The deterministic per-game×day object key format, the checksum algorithm, and how the seal-time end-to-end-decode result is encoded into `integrity_ref` are `/plan`-level decisions. Must be deterministic (idempotent overwrite depends on it) and collision-free across games×days.
- **`raw_retention_days` expiry mechanism (T-07.23).** Prefer native S3 bucket lifecycle rules where the target (MinIO/Arvan) supports them; fall back to a scheduled expiry sweep otherwise. `/plan` must confirm the chosen S3-compatible target's lifecycle-rule support and reconcile the two distinct retention knobs (`cold_storage_local_retention_days` = local disk; `raw_retention_days` = S3 object) so an operator does not confuse them.
- **Shared S3 target — bucket/prefix collision risk (T-07.28).** PITR (FR-028) and cold storage share one S3-compatible endpoint. `/plan` must pin distinct prefixes/buckets and ensure `raw_retention_days` expiry rules are scoped so they can **never** delete PG-backup objects (a mis-scoped lifecycle rule expiring WAL archives would silently defeat FR-028's disaster-recovery guarantee — a cross-phase hazard).
- **Rebuild tool is deferred; the filter contract is not.** T-07.26 records the normative obligation (re-dedup + `ERASURE_LEDGER` refilter + logical-day flooring, bridge 01.5 §5.1). The actual replay tool build is deferred to a later phase (bridge 01.5 §5.1, research §X-1). **Flag:** if any v1 tool is built that reads a shipped object (even ad-hoc ops tooling), it MUST honor the ledger filter — a rebuild that skips it re-materializes erased data (00.5 §7.3). This is a landmine for future work reading 07's objects.
- **Local disk sizing.** Consequence of ship-at-seal: local disk holds ~3 open files + the retention-window sealed files per game (bridge 01.5 §6). At the 00.5 §2 envelope (≤ 25 games) this is small, but `/plan` should note disk-headroom monitoring for the `cold_storage_local_retention_days > 0` case and the persistent-failure accumulation case (T-07.20) — files pile up in `COMPLETE` on bad credentials with no automatic bound.
- **Single append-writer per open file (bridge 01.5 §4) is a Phase-01 build, not 07.** Noted so /plan does not double-assign it: the group-commit append-writer that serializes concurrent workers into one fsync lives in 01's ingest path. 07 depends on its output but implements none of it.
- **No Redis state for this phase (07 §Design Redis table).** All nightly-job coordination is Postgres-`UPLOAD_BOOKKEEPING` + BullMQ schedule; deliberately no job-lock/cursor/counter in Redis (must survive Redis loss; eligibility is state-derived). `/plan` should not introduce a Redis lock "for safety" — an overlapping run is already overwrite-idempotent (T-07.18), and a Redis-resident lock would violate the Foundation §6 accepted-loss posture for Redis.
