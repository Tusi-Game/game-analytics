# Project Constitution — 001-analytics-platform

**Status:** draft (2026-07-17) · **Source:** `spec.md` Next Steps §4 · **Authority:** these principles bind every phase task list and every `/plan` decision. A design or implementation that violates a principle must **flag it**, never silently override it (Foundation §8.8).

These are the non-negotiable invariants distilled from the locked design (Q1–Q10 + the adversarial hardening pass). They exist so that any implementer — or future agent — can check a proposed change against a short, stable list rather than re-reading 22 spec files.

---

## P1 — Results-only storage
Postgres holds **only processed results + the minimal per-user spine** — never raw event logs (FR-010, SC-007). The spine is ONE family, three tiers (Foundation §1.3); any new per-user durable structure requires a ledger amendment in `spine-budget-ledger.md` first, not a new table. `PURCHASE_IDEMPOTENCY` is a uniqueness-key table, permitted alongside — not an event log. **Test:** could this store re-derive every metric without re-scanning raw events? If not, it violates P1.

## P2 — Disposable raw data
Raw events live only transiently (wire → BullMQ → raw day-file → S3 → deleted local). Losing a day's raw file or the Redis cache is **acceptable by design**; the raw file is the manual-rebuild floor, not a database (FR-023/024, US5). Correlate with P7: what must survive is the *durable Postgres result*, never the raw stream.

## P3 — Config-driven, no code changes for strategy
Every operational choice is an operator knob (FR-027): flush cadence, dedup window, day-seal grace, name cap, cold-storage target, monetization dimensions, retention targets, level buckets, `reporting_offset`. Changing strategy must never require a code change. Config changes apply **forward-only** unless the knob is explicitly retroactive (each §6 states which).

## P4 — Single-command deploy
The entire platform (ingest API, workers, Redis, Postgres, panel) starts with one `docker-compose up` on a modest VPS (SC-009). It phones home to nothing external and depends on no blocked cloud (sanctions constraint). S3 target is any S3-compatible provider (MinIO/Arvan/…).

## P5 — Server-trusted money
Revenue is **server-verified only** (FR-021, Foundation §4.5). Trust is derived from the **class of the authenticating credential** (`sdk_key` = client/untrusted, `server_credential` = server/trusted) — never from the event body. The client emits a zero-money **context companion** joined to the server row by the SDK-minted **`purchase_attempt_id`** (NOT the store `transaction_id`). Money never double-counts: purchases dedup **durably** by `transaction_id` (Postgres UNIQUE), never a time window.

## P6 — Write-ahead raw-file durability
A worker appends the fsync'd raw file (when cold storage is on) **before** updating any counter, spine bit, or Redis cell (FR-009, SC-008, Foundation §3.1 step 4). This guarantees the raw file is always a complete **superset** of anything counted — there is never a counted-but-unlogged event. Counter-first ordering is a bug by construction.

## P7 — Durability tiering: never lose Postgres
The durability posture is explicit and asymmetric (Foundation §6): Postgres results/spine loss is **NOT acceptable** and is protected by automated PITR backup to S3 with tested restore (FR-028); Redis (≤1s AOF window) and raw-file loss **are** accepted. Spine bits and money are **durable-immediate** (straight to Postgres, never flush-mediated) so a Redis crash can never corrupt retention or revenue.

## P8 — One canonical time model: the platform logical day
There is ONE platform timezone (`reporting_offset`, set-once at install) through which **every** metric and **every** seal is computed: `logical_day(t) = utc_day(t + reporting_offset)` (Foundation §4.7). It is **correctness-bearing**, not display-only. Event-time is skew-corrected (Foundation §4.2) and the server clock is disciplined by a **slewing** NTP daemon, never stepped. Changing `reporting_offset` after data exists is forbidden (it would re-bucket sealed history).

## P9 — One writer per structure
Every durable/hot structure has exactly one owner that writes it; everyone else reads (Foundation §5 ownership matrix). Cross-story writes are named exceptions with a contract (e.g. 02 writes `USER_SPINE` per bridge 02.5; 06 writes `PAYER_SPINE_EXT` inside 05's gate per bridge 05.5). No structure has two independent writers.

## P10 — Idempotent, class-typed flush
Redis→Postgres flushes are absolute-value upserts under a per-class merge rule (M/N/S/L, Foundation §3.2.1): monotonic-max, gen-gated (monetization mutable-down), set-union, or as_of-LWW. Every flush is a **no-op on retry** by construction. Rehydrate-on-miss + the `seeded` marker make flushes safe after a Redis loss. Deltas never flush — only absolutes; anything not expressible as an absolute is a durable-immediate write.

## P11 — Fast-ack ingestion, backpressure-safe
The ingest endpoint validates + enqueues and returns **without blocking on processing** (FR-006, SC-002). A traffic spike is absorbed by the queue / rejected at the door (rate limiting, 00.5), never by stalling ingestion. Client gameplay is never blocked by processing latency.

## P12 — Multi-game isolation
No query or dashboard view ever crosses game boundaries (FR-002, SC-003). `game_id` is server-derived from the authenticating key, never trusted from the body (FR-001). Isolation is for correctness/cleanliness (solo operator, own games) — not adversarial multi-tenant security in v1.

## P13 — Privacy & compliance by default
PII default-deny (a non-empty `pii_prop_denylist` + value scrubber before raw-append); reversible infra secrets encrypted with a master key held **outside** Postgres (FR-029); TLS required for all credential/event traffic; GDPR Art.15/20 access + Art.17 erasure honored via the four-tier posture (Q7, 00.5 §7) — hard-delete spine, scrub membership, leave aggregates, detach `PURCHASE_IDEMPOTENCY`, refilter raw via `ERASURE_LEDGER`.

---

## Amendment rule
A principle changes only by an explicit decision recorded here with rationale + date, mirrored into the affected design specs. The design layer's Q1–Q10 records and the adversarial-hardening ledger (`research.md` §7–§8) are the precedent library for how such decisions are made and sourced.
