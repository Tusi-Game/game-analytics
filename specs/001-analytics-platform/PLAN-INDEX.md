# Implementation Plan — Index & Build Order (001-analytics-platform)

**Layer:** implementation task lists (each story-spec's `tasks.md`, siblings `002`–`012`) · **Status:** task-list pass complete (2026-07-17) · **Restructured:** 2026-07-17 — task lists moved into their story-spec dirs when the umbrella split into per-story specs.
**Grounding:** every story `tasks.md` is a read-only projection of its locked design (`design.md` + shared [`foundation.md`](foundation.md), Q1–Q10 + hardening) into atomic build tasks. The design is frozen; these files add only the *how-to-build* layer the specs deliberately excluded. Where two stories share an interwoven task list (sessions+retention, monetization+KPIs, client+server SDK), the combined list lives in the lower-numbered owner and the sibling's `tasks.md` is a pointer.

This index is the manager's map over the task-list files. It gives: (1) the file inventory, (2) the cross-phase build order, (3) the consolidated reconciliation ledger (the cross-cutting flags every agent surfaced that must be settled **once, platform-wide, at `/plan`** — not nine times), and (4) the entry criteria for `/plan`.

---

## 1. Task-list inventory

| Story `tasks.md` | Phase(s) | Tasks | Owns (build) |
|---|---|---|---|
| [`002-foundation-ingest`](../002-foundation-ingest/tasks.md) | 00 + 00.5 Foundation/Ops **and** 01 + 01.5 Ingest/Raw-file | 146 | envelope, wire contract, BullMQ door, 9-step op-order kernel, M/N/S/L flush engine, rehydrate machinery, skew/clock/seal/dedup, provenance derivation, logical-day, shared ER skeleton, scale/backpressure/rate-limit, GDPR erasure + DSAR, PITR/DR, secrets/TLS, docker-compose skeleton · `/v1/events` endpoint, batch validate+enqueue, catalog auto-registry, `EVENT_DAY_COUNT`/`EXCEPTION_TALLY`, drop-vs-quarantine, name-cap, write-ahead raw day-file (framed gzip, fsync, rotation, quarantine tail), manual-rebuild floor |
| [`003-sessions`](../003-sessions/tasks.md) | 02 + 02.5 + 04 Sessions/Retention (combined; 005 points here) | 56 | session tracking (30-min, sendBeacon, server-authoritative close), `SESSION_DAY_RESULT`/`ACTIVE_USER_DAY`, the `USER_SPINE` durable-immediate writes (seq A/B), `COHORT`/`RETENTION_CELL`, classic Day-N calc, immature/small-cohort/survivorship guards |
| [`004-economy`](../004-economy/tasks.md) | 03 Economy | 43 | `ECONOMY_FLOW_RESULT` (+ segmented), `BALANCE_SNAPSHOT` (class-L), `ECONOMY_SUPPLY_DAY` snapshot, source/sink/net/ratio, per-reason top-N, low-volume guard, currency cap |
| [`006-monetization`](../006-monetization/tasks.md) | 05 + 05.5 + 06 Monetization/KPIs (combined; 007 points here) | 85 | `PURCHASE_IDEMPOTENCY` durable dedup, `MONETIZATION_CELL`/`PAYER_DAY` (class-N gen-gated), enrichment MOVE + companion join, FX as-of + park-unconverted + whale-abstention, seal-gating reconciliation, `PAYER_SPINE_EXT`/`PAYER_PERIOD_SPEND` (gate-coupled), DAU/WAU/MAU/stickiness/ARPU/ARPPU/ARPDAU/conversion/whale |
| [`008-cold-storage`](../008-cold-storage/tasks.md) | 07 Cold-storage | 34 | nightly ship-at-seal job, S3-compatible upload, `UPLOAD_BOOKKEEPING`, delete-local, retention-expiry, erasure-ledger refilter contract |
| [`009-client-sdk`](../009-client-sdk/tasks.md) | 08 + 09 SDKs (combined; 010 points here) | 59 | client SDK (buffer/retry/anon/session/companion/identify), server SDK (server-provenance money path), shared npm monorepo (changesets, OIDC trusted-publish + provenance) |
| [`011-operator-admin`](../011-operator-admin/tasks.md) | 10 Operator/Admin | 47 | `OPERATOR_ACCOUNT` (auth/MFA/lockout), game registration + credential lifecycle (dual-active rotation), config admin over every §6 knob (forward-only), `CONFIG_AUDIT`, GDPR Art.15/20 admin surface |
| [`012-panel`](../012-panel/tasks.md) | 11 Panel | 90 | NestJS MVC + Nunjucks, Tailwind/asset pipeline, HTMX/Alpine/Chart.js, read-model merge consumption (§3.3), full view inventory, auth gate reuse |

**Total: ~560 atomic build tasks + ~40 `/plan` flags.**

---

## 2. Cross-phase build order

Derived from the `phases/README.md` dependency table + the ownership matrix (Foundation §5) + each agent's stated blockers. Phases within a stage are parallelizable; stages are gated.

```
Stage A — Substrate (build as ONE unit; see Ledger R1)
  00 Foundation kernel + 00.5 ops  ─┐
  01 Ingest front-door (steps 1–6)  ─┘   ← Foundation defines the seam, 01 realizes the front-door
        + 01.5 raw day-file
        gate: routed-record contract frozen & tested; SC-008 write-ahead proven

Stage B — Registry (unblocks real auth for everything above and below)
  10 Operator/Admin: OPERATOR_ACCOUNT, game registration, credential issuance/rotation, config admin
        (a minimal GAME/credential seed exists in 01 T-01.6 so Stage A is testable before this lands)

Stage C — Metric stories (parallel; each is a step-7/8 consumer of the frozen routed record)
  02 Sessions ──▶ 04 Retention   (04 verifies only after 02; both write USER_SPINE per bridge 02.5)
  03 Economy
  05 Monetization ──▶ 06 Derived KPIs   (06 = gate-coupled to 05, NOT downstream; bridge 05.5)
        gate: SC-004/005/006 hand-computed-truth parity per story

Stage D — Edges & lifecycle (parallel; consume Stage A–C outputs)
  07 Cold-storage lifecycle       (needs 01 producing local day-files)
  08 Client SDK + 09 Server SDK   (share golden fixtures with 01 — see Ledger R4)

Stage E — Presentation
  11 Panel   (pure reader; needs 10 for auth/writes + 01–07 result structures + §3.3 merge)
        gate: SC-001/003 + FR-025/026 view parity
```

**The single most important sequencing ruling (Ledger R1):** Foundation's op-order kernel and 01's front-door (steps 1–6) are nearly the same buildable unit. Build them together; freeze the *routed-record contract* (envelope + resolved kind + stamped `v` + corrected day + front-door verdicts) before any Stage-C story starts, because 02–06 consume it as-is and must never re-derive a front-door decision.

---

## 3. Consolidated reconciliation ledger — settle ONCE at `/plan`

Every agent independently surfaced cross-cutting concerns. These are **not** per-phase decisions; each must be ruled once and applied platform-wide, or the phases silently diverge. Ordered by blast radius.

| # | Concern | Phases touched | Recommended ruling | Blocking? |
|---|---|---|---|---|
| **R1** | **Kernel/front-door seam.** Foundation §3.1 says steps 1–6 run "in the 01 front-door"; Foundation and 01 both nearly claim the front-door realization. | 00, 01, and *read by* 02–06 | Foundation **defines** the seam + routed-record contract; **01 realizes** the front-door (steps 1–6); 02–06 consume the routed record verbatim. Build 00-kernel+01 as one unit. | **Yes** — freeze before Stage C |
| **R2** | **`purchase_attempt_id` vs `transaction_id` for the companion join.** The hardened design (05.5 §2, 08 §3.2, 09 §3) uses SDK-minted `purchase_attempt_id`; but **`spec.md` FR-021/§D still say "keyed by `transaction_id`"** and 05's own Redis table still names `{game_id}:stage:{transaction_id}`. Keying on the store id silently empties segmented-monetization dims in production. | 05, 05.5, 08, 09, **spec.md** | Ratify `purchase_attempt_id` as the sole context-join + `stage` key. **Back-propagate to `spec.md` FR-021/§D** (the requirement was never rewritten after the hardening pass) and correct 05's Redis-table naming lag. All task lists already build on `purchase_attempt_id`. | **Yes** — spec.md inconsistency |
| **R3** | **Cap posture: drop-and-tally `capexceeded` vs `other`-overflow.** Phase 01 (event-name cap) and 03 step-3 (currency cap) say *drop*; Foundation §2.3's shared observed-value-cap convention says over-budget values *collapse into a counted `other` bucket*. Same tension for 05 client dimensions. | 00 (§2.3), 01, 03, 05 | One platform-wide ruling. §2.3 is presented as the *shared* convention → prefer `other`-overflow (kept+counted) for cardinality caps; reserve drop-and-tally for truly uncountable input (nameless/unparseable). Reconcile 01/03's step tables to §2.3. | **Yes** — normative conflict |
| **R4** | **Shared golden fixtures / reference stream.** 01 ingest tests, 08 client SDK, and 09 server SDK must consume ONE physical fixture set or the two wire ends drift. | 01, 08, 09 | Create a single shared `fixtures/` (golden envelope stream) co-owned by 01/08/09; both SDK conformance tests and 01 ingest tests read it. | No (but cheap; do early) |
| **R5** | **`EXCEPTION_TALLY` reason-enum ownership.** 01 owns the table, but `negative_offset` (04), `fx_stale_rate_used`/`fx_unconverted` (05), `rate_limited` (00.5) are produced elsewhere. | 00.5, 01, 04, 05 | Declare the full reason enum ONCE in 01's schema task (already listed in Foundation §1.2). Producing phases reference it; none re-declares. | No — declare-once hygiene |
| **R6** | **Seal-time gzip decode-verify seam.** 01 appends the raw file; 07 seals/ships. The end-to-end decode-check (01.5) must be owned in exactly one place or it falls in the gap. | 01, 07 | Assign to 07's pre-upload path (it already runs at seal/nightly). 01 owns per-append framing; 07 owns the whole-file decode-verify gate. | No — assign one owner |
| **R7** | **`last_used_at` write amplification.** Stamping it per credential-use on the hot path contradicts results-only / no-per-event-Postgres-write. | 00 (front door), 10 | Throttled/periodic flush (e.g. coalesce in Redis, flush on the 5-min cadence) rather than per-use write. Reconcile with 01's front-door. | No — perf, not correctness |
| **R8** | **Operational Redis namespace outside §2.1 grammar.** Phase 10 (config cache, operator sessions) and 11 (`credential:show` flag, download tokens) introduce non-per-game keys under `noeviction`. | 00 (§2.1), 10, 11 | Reserve a platform `ops:*` / `panel:*` namespace in §2.1's grammar; all must expire by TTL (safe under `noeviction`). One owner for the reserved tags. | No — grammar extension |
| **R9** | **`FX_RATE` storage shape.** Referenced by 05's as-of lookup + reconciliation, but only `fx_table` *config material* is in Foundation §1.2 — no durable rate entity. | 00 (§1.2), 05 | `/plan` decides the rate-store shape + master-key decryption boundary (it holds reversible secret-adjacent material per FR-029). | No — schema decision |
| **R10** | **Segmented retention has no consumer.** Context props are captured, the small-cohort guard is called "load-bearing" for retention × segment, but no 02/04 task rolls retention up by segment. | 04, 06, 11 | Decide if segmented retention is v1-scoped for the panel. If yes → task it in 06 or 11 with sub-denominators feeding the same guard. If no → document the defer. | No — scope decision |
| **R11** | **Server-SDK session activeness.** If 09 can emit `kind=session`, may it set the activeness bit? The design implies client-engagement-only. | 02, 09 | `/plan` rules whether server-emitted sessions count toward activeness (recommend: no — activeness = client engagement; the `session`-kind gate is the only enforcement point). | No — semantic ruling |
| **R12** | **`drop_counter_visible` knob** gates the panel exceptions view but is absent from phase 10's config inventory (likely an 01 knob 10 omitted). | 01, 10, 11 | Confirm ownership (01 defines, 10 surfaces, 11 reads); add to 10's inventory. | No — inventory gap |
| **R13** | **npm `<org>` scope** is unresolved operator input; blocks first `npm publish` (OIDC + provenance bind to the concrete scope). Also `reporting_offset` set-once has no structural enforcement. | 08, 09 (scope); 00/10 (offset) | Operator supplies the npm org before first publish (not before dev). Config-validation layer needs a "data-exists" predicate to hard-block `reporting_offset` edits. | No — external input / guard |

**Rulings R1–R3 are blocking** (a seam contract, a spec.md inconsistency, and a normative conflict). R4–R13 are hygiene/perf/scope items that `/plan` should settle but none blocks starting Stage A.

---

## 4. `/plan` entry criteria

Per `spec.md` Next Steps, before `/plan`:
1. ✅ Task lists authored for every phase (this pass).
2. ⬜ **Constitution** established — see [`../../.specify/memory/constitution.md`](../../.specify/memory/constitution.md) (drafted alongside this pass).
3. ⬜ **Settle R1–R3** (blocking ledger items) — a seam ruling, the `spec.md` FR-021 back-propagation, and the cap-posture ruling.
4. ⬜ Funnels scope (FR-022) — remains design-only/deferred; no task list authored (correct per README scope note).
5. ⬜ Operator sign-off on this plan + ledger.

Once R1–R3 are ruled and the constitution is ratified, `/plan` can proceed against these task lists as the per-phase implementation input.
