# Implementation Plan — 001-analytics-platform

**Status:** draft (2026-07-18) · **Layer:** Spec Kit `/plan` — sits **above** the 11 per-story task lists (`002`–`012`'s `tasks.md`) and **below** the frozen design (`spec.md` + `foundation.md` + `design.md` per story).
**Authority:** this document **settles the [`PLAN-INDEX.md`](PLAN-INDEX.md) §3 reconciliation ledger platform-wide** (R1–R13). Those rulings bind every phase; the per-story `tasks.md` files are the implementation input `/plan` hands to the build. This file does **not** re-open any frozen design decision (Q1–Q10, the adversarial-hardening pass, the constitution P1–P13) — it records the cross-cutting rulings the task-list pass deliberately deferred to a single settle-once step.

**How to read it:** §1 orients (architecture, one screen — do not re-derive [`foundation.md`](foundation.md)). §2 is the gated build order. §3 is the core: R1–R13, each actionable by an implementer. §4 lists the per-story `[OPEN]`/`[LEANING]` questions carried forward with documented defaults (so `/plan` is unblocked). §5 mirrors the PLAN-INDEX §4 entry-criteria status.

---

## 1. Architecture overview

One **single-process NestJS platform** (TypeScript end-to-end) runs the ingest API, the BullMQ workers, and the server-rendered panel in the same deployable; Redis backs the queue + hot counters, Postgres holds durable results + the minimal per-user spine, and an S3-compatible bucket is cold storage. The whole stack comes up with one `docker-compose up` on a modest VPS and phones home to nothing external (constitution **P4**, SC-009).

| Tier | Realization | Constitution |
|---|---|---|
| Ingest front-door | `POST /v1/events` — validate + enqueue + fast-ack, `game_id` server-derived from key class | **P11** (fast-ack), **P12** (isolation), **P5** (server-trust) |
| Processing | BullMQ workers: **raw-file append (write-ahead) → Redis hot cells → metric processing**; 5-min idempotent absolute-upsert flush to Postgres; durable-immediate spine/money writes | **P6**, **P10**, **P1** |
| Durable store | Postgres = results + one-family/three-tier spine only (never raw logs); PITR backup to S3 | **P1**, **P7** |
| Transient store | Redis = queue + ≤1-day hot counters, AOF `everysec` + `noeviction` | **P2**, **P7** |
| Cold store | per-game daily gzip raw file → nightly ship-at-seal → S3-compatible → delete-local | **P2** |
| Presentation | NestJS MVC + Nunjucks + Tailwind/HTMX/Alpine/Chart.js panel; today=Redis / sealed=Postgres merge | **P12** |
| Time | one platform logical day `logical_day(t) = utc_day(t + reporting_offset)`, correctness-bearing, set-once | **P8** |

Everything above is the frozen design; this plan does not restate it. The seam that binds the tiers — the **routed record** the front-door produces and every metric story consumes verbatim — is the subject of ruling **R1** below. For the entity model see [`ER-full.md`](ER-full.md); for backbone/ownership see [`foundation.md`](foundation.md) §1–§5; for each story's realization see its `design.md`.

---

## 2. Build order & gating

Restated from [`PLAN-INDEX.md`](PLAN-INDEX.md) §2 (derived from the `foundation.md` §5 ownership matrix). **Phases within a stage parallelize; stages are gated** — a stage may not start until the prior stage's gate is proven.

| Stage | Phases (story dirs) | Gate condition |
|---|---|---|
| **A — Substrate** (build as ONE unit, ruling R1) | 00 kernel + 00.5 ops **and** 01 front-door + 01.5 raw day-file → [`002-foundation-ingest`](../002-foundation-ingest/) | **Routed-record contract frozen & tested**; SC-008 write-ahead ordering proven (raw append before any counter). |
| **B — Registry** | 10 operator/admin → [`011-operator-admin`](../011-operator-admin/) | Real `OPERATOR_ACCOUNT` auth, game registration, credential issue/rotate, config admin live. (A minimal GAME/credential seed exists in 01 `T-01.6` so Stage A is testable before B lands.) |
| **C — Metric stories** (parallel) | `[02 Sessions ▶ 04 Retention]` · `03 Economy` · `[05 Monetization ▶ 06 Derived-KPIs]` → [`003`](../003-sessions/) · [`005`](../005-retention/) · [`004`](../004-economy/) · [`006`](../006-monetization/) · [`007`](../007-derived-kpis/) | Per story: **SC-004/005/006 hand-computed-truth parity**. 04 verifies only after 02 (both write `USER_SPINE` per bridge 02.5). 06 is **gate-coupled to 05, not downstream** (bridge 05.5). |
| **D — Edges & lifecycle** (parallel) | `07 Cold-storage` · `[08 Client SDK + 09 Server SDK]` → [`008`](../008-cold-storage/) · [`009`](../009-client-sdk/) · [`010`](../010-server-sdk/) | 07 needs 01 producing local day-files. 08/09 share golden fixtures with 01 (ruling R4). |
| **E — Presentation** | 11 Panel → [`012-panel`](../012-panel/) | SC-001/003 + FR-025/026 view parity. Pure reader — needs 10 (auth) + 01–07 result structures + the §3.3 read-model merge. |

**The single most important sequencing ruling is R1** (§3): 00-kernel and 01's front-door (steps 1–6) are nearly one buildable unit; freeze the routed-record contract before any Stage-C story starts, because 02–06 consume it as-is and must never re-derive a front-door decision.

---

## 3. Reconciliation rulings R1–R13

The core section. Each ledger item (PLAN-INDEX §3) is now ruled once, platform-wide. Format: **concern** → **RULING** → **applies to** → **enforcement/next**. R1–R3 were flagged blocking and are now **RESOLVED**; R4–R13 are hygiene/perf/scope items — none blocks starting Stage A, but each is settled here so the phases cannot silently diverge.

### R1 — Kernel/front-door seam **[BLOCKING — RESOLVED]**
**Concern:** Foundation §3.1 and 01 both nearly claim the front-door realization (steps 1–6); who defines vs. realizes the seam is ambiguous.
**RULING:** **Foundation DEFINES** the seam and the **routed-record contract** — envelope + resolved `kind` + stamped wire `v` + corrected logical-day + front-door verdicts (drop/quarantine/route). **Phase 01 REALIZES** the front-door (steps 1–6). **Phases 02–06 consume the routed record VERBATIM and must never re-derive a front-door decision.** Build 00-kernel + 01-front-door as **ONE unit** (Stage A).
**Applies to:** 00, 01; read-only by 02–06. Constitution **P8** (day already corrected upstream), **P11** (fast-ack front-door), **P12** (`game_id` server-derived). FR-001/006/008b.
**Enforcement/next:** **freeze + test the routed-record contract before any Stage-C story starts** (Stage A gate). Contract owner = Foundation; realization owner = 01. This is the Stage A→C gate.

### R2 — Companion-join key vs. dedup key **[BLOCKING — RESOLVED]**
**Concern:** the hardened design (bridge 05.5, 08, 09) joins the client context companion on the SDK-minted `purchase_attempt_id`, but `spec.md` FR-021/§D still read "keyed by `transaction_id`" and 05's Redis staging table still named `{game_id}:stage:{transaction_id}`. Keying the join on the store id silently **empties segmented-monetization dims in production** — the client companion never carries the store id.
**RULING:** SDK-minted **`purchase_attempt_id` is the SOLE companion-join key AND the Redis `stage` key**. Store **`transaction_id` REMAINS the durable dedup/idempotency uniqueness key** (Postgres UNIQUE). Two different keys, two different jobs.
**Applies to:** 05, bridge 05.5, 08, 09, and `spec.md`. Constitution **P5** (join key ≠ money-dedup key, both named there). FR-021, SC-006.
**Enforcement/next:** **already back-propagated** in the drift/back-prop pass — `spec.md` FR-021/§D and acceptance-scenario 3 now say `purchase_attempt_id`; 006's Redis staging table renamed to `{game_id}:stage:{purchase_attempt_id}`. All task lists already build on `purchase_attempt_id`. **No further spec edit required** — referenced here as done.

### R3 — Cap posture: `other`-overflow vs. drop-and-tally **[BLOCKING — RESOLVED]**
**Concern:** phase 01 (event-name cap) and 03 step-3 (currency cap) say **drop**; Foundation §2.3's shared observed-value-cap convention says over-budget values **collapse into a counted `other` bucket**. Same tension for 05 client dimensions. A normative conflict between a shared convention and two step tables.
**RULING:** **`other`-overflow (kept + counted) is the platform-wide default for CARDINALITY caps** — event-name cap (01), currency cap (03 step-3), client dimensions (05) — because Foundation §2.3's observed-value-cap is presented as the **shared** convention and must win over the per-step tables. **Reserve drop-and-tally** (`capexceeded` / quarantine) for **truly uncountable input only** — nameless / unparseable / no key to bucket under.
**Applies to:** 00 (§2.3), 01, 03, 05. Constitution **P3** (caps are operator knobs, §H-4 defaults 500/50). FR-008c, FR-013/014.
**Enforcement/next:** reconcile 01 and 03's step tables to §2.3 **at implementation** — recorded as a `/plan` flag on those two `tasks.md` (a reconciliation note during the build, not a re-author of the frozen design now). The `other` bucket must feed the same rollup grain; the counter that used to be `dropped_*` becomes an `other`-overflow tally.

### R4 — Shared golden fixtures **[hygiene — do early]**
**Concern:** 01 ingest tests, 08 client SDK, and 09 server SDK must consume ONE physical fixture set or the two wire ends drift.
**RULING:** create **ONE shared `fixtures/` golden envelope stream**, co-owned by 01 / 08 / 09; both SDK conformance tests **and** 01 ingest tests read it.
**Applies to:** 01, 08, 09. Constitution **P5** (one wire contract). FR-005/007/008.
**Enforcement/next:** cheap; land it early in Stage A so Stage-D SDKs and Stage-A ingest can never diverge on wire shape. One physical fixture dir, three consumers, no copies.

### R5 — `EXCEPTION_TALLY` reason-enum ownership **[hygiene — declare-once]**
**Concern:** 01 owns the table, but reason codes are produced elsewhere — `rate_limited` (00.5), `negative_offset` (04), `fx_stale_rate_used` / `fx_unconverted` (05).
**RULING:** the **full reason enum is declared ONCE in 01's schema task** (Foundation §1.2 already lists it). Producing phases **reference** it; none re-declares.
**Applies to:** 00.5, 01, 04, 05. Constitution **P9** (one writer / one declarer). FR-008c.
**Enforcement/next:** 01's schema task is the single source of the enum; add `unknown_kind` (Foundation §1.1 wire contract) if not already present. Producing phases cite the code, never invent a new spelling.

### R6 — Seal-time gzip decode-verify seam **[hygiene — one owner]**
**Concern:** 01 appends the raw file; 07 seals/ships. The end-to-end decode-check (01.5) must be owned in exactly one place or it falls in the gap.
**RULING:** **01 owns per-append framing** (framed gzip, fsync, rotation); **07 owns the whole-file decode-verify gate** in its pre-upload (seal/nightly) path. The end-to-end decode check lives in exactly one place — **07**.
**Applies to:** 01, 07, bridge 01.5. Constitution **P2** (raw = rebuild floor), **P6** (write-ahead framing). SC-008, FR-023/024.
**Enforcement/next:** 07's pre-upload path runs the whole-file decode-verify before ship; a file that fails decode is not shipped and not delete-local'd — it is quarantined/alarmed.

### R7 — `last_used_at` write amplification **[perf — not correctness]**
**Concern:** stamping `last_used_at` per credential-use on the hot path contradicts results-only / no-per-event-Postgres-write.
**RULING:** **throttled/periodic flush** — coalesce `last_used_at` in Redis, flush on the **5-min cadence** — **not** a per-credential-use Postgres write.
**Applies to:** 00 (front door), 10. Constitution **P1** (results-only, no per-event write), **P11** (fast-ack). FR-011a.
**Enforcement/next:** reconcile with 01's front-door hot path; the credential-use timestamp rides the same 5-min flush as the aggregate cells. Perf, not correctness — a slightly stale `last_used_at` is acceptable.

### R8 — Operational Redis namespace outside §2.1 grammar **[hygiene — grammar extension]**
**Concern:** phase 10 (config cache, operator sessions) and 11 (`credential:show` flag, download tokens) introduce non-per-game keys under `noeviction`.
**RULING:** **reserve a platform `ops:*` / `panel:*` namespace** in Foundation §2.1's key grammar; **everything under it MUST expire by TTL** (safe under `noeviction`). One owner for the reserved tags.
**Applies to:** 00 (§2.1), 10, 11. Constitution **P12** (per-game grammar stays isolated; ops/panel keys are explicitly platform-scoped, TTL-bounded). FR-011.
**Enforcement/next:** extend §2.1's grammar with the two reserved prefixes at implementation; a `noeviction` Redis cannot leak non-expiring ops keys, so the TTL requirement is normative, not advisory.

### R9 — `FX_RATE` storage shape **[schema decision — DEFERRED, documented reason]**
**Concern:** referenced by 05's as-of lookup + reconciliation, but only `fx_table` *config material* is in Foundation §1.2 — no durable rate entity.
**RULING:** the durable **FX rate-store shape + the master-key decryption boundary** (it holds reversible secret-adjacent material per FR-029) is **decided at detailed design of phase 05**, not here. Recorded as an **OPEN schema slot**.
**Applies to:** 00 (§1.2), 05. Constitution **P13** (reversible secrets encrypted with a master key held outside Postgres). FR-029, §D-2 (FX stamped at purchase UTC date, sealed days not re-normalized).
**Enforcement/next:** **defers with documented reason** — the rate-store shape does not gate Stage A and is entangled with the FR-029 master-key boundary that 05's detailed design must settle anyway. Flag carried into 06's `tasks.md` design step; not a Stage-A blocker.

### R10 — Segmented-retention consumer **[scope decision — DEFERRED, documented reason]**
**Concern:** context props are captured and the small-cohort guard is called "load-bearing" for retention × segment (005 §55), but no 02/04 task rolls retention up by segment — the feature has **no consumer**.
**RULING:** segmented retention is **DESIGN-CAPTURED but v1-DEFERRED** for the panel. Context props + the small-cohort guard exist; **no 02/04 task rolls retention up by segment**, so v1 ships none. **Document the defer.** If later scoped-in → task it in 06 or 11 with sub-denominators feeding the **same** small-cohort guard.
**Applies to:** 04, 06, 11. Constitution **P1** (no new durable structure without a ledger amendment — segmenting would multiply cells). FR-017, SC-005.
**Enforcement/next:** **defers with documented reason** — matches "no consumer today"; the conservative posture is to not build a segmented rollup no view reads. The guard machinery is already load-bearing, so a later scope-in is additive, not a rewrite. Surfaced in §4 as a genuine scope decision.

### R11 — Server-SDK session activeness **[semantic ruling]**
**Concern:** if 09 can emit `kind=session`, may it set the activeness bit? The design implies client-engagement-only.
**RULING:** **server-emitted sessions do NOT count toward activeness.** Activeness = **client engagement**; the `session`-kind gate is the **only** enforcement point. A server-supplied `session_id` may ride along but never starts/closes a session and never sets a retention bit.
**Applies to:** 02, 09 (and cross-checked by 003 §S-1, 007 DK-4). Constitution **P5** (provenance by credential class), **P9** (02 is the sole `USER_SPINE` writer). FR-015/016, SC-005.
**Enforcement/next:** the `session`-kind path in 02 is the single gate; 09/010's server path emits `purchase`/`economy` only and never trips the activeness bit. Aligns 003 §S-1 default (b) and 007 DK-4 (`active = ≥1 session-start`).

### R12 — `drop_counter_visible` knob inventory gap **[inventory gap]**
**Concern:** the `drop_counter_visible` knob gates the panel exceptions view but is absent from phase 10's config inventory (likely an 01 knob 10 omitted).
**RULING:** **01 DEFINES** the knob, **10 SURFACES** it (add to 10's config inventory), **11 READS** it. Confirm the ownership chain; the gap is 10's inventory omission.
**Applies to:** 01, 10, 11. Constitution **P3** (every operational choice is an operator knob, forward-only config). FR-027.
**Enforcement/next:** add `drop_counter_visible` to 10's `CONFIG` inventory task; no new owner — pure inventory completion. 11's exceptions view reads it.

### R13 — npm `<org>` scope + `reporting_offset` guard **[external input / guard]**
**Concern:** the npm `<org>` scope is unresolved operator input and blocks the first `npm publish` (OIDC + provenance bind to the concrete scope); separately, `reporting_offset` set-once has no structural enforcement.
**RULING:** **(a)** the operator supplies the concrete npm **`<org>` scope before FIRST publish** (OIDC + provenance bind to it) — **not** required before dev, so it never blocks Stage A/D build work. **(b)** the config-validation layer needs a **"data-exists" predicate** that **HARD-BLOCKS `reporting_offset` edits once any data exists** — structural enforcement of the P8 set-once invariant.
**Applies to:** 08, 09 (scope); 00, 10 (offset guard). Constitution **P8** (logical day set-once, changing after data exists is forbidden), **P4** (OIDC trusted-publish + provenance). FR-027, FR-029.
**Enforcement/next:** (a) is an operator-input checklist item gating the publish task only. (b) is a build task on 10's config-validation layer — the `data-exists` predicate is the structural teeth P8 currently lacks; without it P8 is only prose.

---

## 4. Open per-story questions carried into detailed design

Stories **002, 003, 005, 006, 007** still carry `[OPEN]` / `[LEANING]` items in their own `spec.md` **"Open questions"** sections. **`/plan` is not blocked by any of them** — each already has a documented default, and this plan does not re-decide them. The reader should consult those sections directly (they hold the full ledger and rationale). Only the few below are genuine **scope** decisions (as opposed to a `[LEANING]` default that simply needs a confirm):

- **Segmented retention — R10** (this doc §3, and [`005-retention/spec.md`](../005-retention/spec.md) §8 + §55 small-cohort guard): whether retention × segment is v1-scoped for the panel. **Ruled defer** here; the only genuine scope call in retention.
- **Whale-concentration spine scope — WC-1** ([`007-derived-kpis/spec.md`](../007-derived-kpis/spec.md) §8, §5(d)): retain the **full** per-payer per-period spend distribution (retroactive re-ranking, payer-bounded cost) vs. a **top-k prefix** (smaller, forward-only percentiles). The one real **SC-007** tradeoff. *Story default: retain full per-payer per-month spend in v1 (payers ≪ users).* A per-story detailed-design confirm, not a `/plan` blocker.
- **Refunds / net revenue — §D-1** ([`006-monetization/spec.md`](../006-monetization/spec.md) §7; inherited by 007 DK-7): gross-only v1 with a `refunded` flag + notification hook for v2 net; sealed days never retro-subtracted. Genuine scope boundary (gross vs. net), **ruled gross-only for v1** by the story default.

Everything else in those sections is a `[LEANING]` with an adopted default — 006 §D-2 (FX ownership, ties R9) / §D-4 (identity↔store mapping); 007 DK-1/2/3/5/6; 003 §S-1 (server sessions, ties R11) / §S-3/4/5; 002 §H-1..4 (type drift, reserved-name routing, PII denylist, cardinality caps ties R3); 005 target-widening horizon and anon-identified double-seed. Read them in place; none needs a `/plan`-level ruling beyond the defaults already recorded.

---

## 5. Entry-criteria status

Mirrors [`PLAN-INDEX.md`](PLAN-INDEX.md) §4, updated for what this document settles:

| # | Criterion | Status |
|---|---|---|
| 1 | Task lists authored for every phase | ✅ (task-list pass, 2026-07-17) |
| 2 | **Constitution** established (`.specify/memory/constitution.md`, P1–P13) | ✅ **drafted** — *ratification is the operator's to confirm* (draft→ratified is an operator checkbox) |
| 3 | **Settle R1–R3** (blocking ledger items) | ✅ **settled in this doc §3** — R1 seam ruling, R2 back-propagation (done), R3 cap-posture ruling |
| 4 | Funnels scope (FR-022) | ✅ **design-only / deferred** — no task list authored (correct per README scope note; [`funnels.md`](funnels.md) is the forward-compatible artifact) |
| 5 | **Operator sign-off** on this plan + ledger | ⬜ **pending** |

R4–R13 are ruled in §3 as well (none blocking). Once item 5 (operator sign-off) lands and the constitution is ratified (item 2), `/plan` is complete and the per-story `tasks.md` files are the implementation input for the build, gated by §2.

**Residual doc-hygiene follow-ups** (discovered and **fixed** in this same pass):

- **`README.md` Status** — the stale *"Currently in the **specify** phase"* line now reflects the `/plan` layer and links this doc.
- **`spec.md` §Open-questions summary** — the resolution-summary prose that still said decisions were *"adopted in phase 03 / metrics"* / *"session defined (phase 02)"* (pre-dating the per-story split that retired the `phases/`/`metrics/` nomenclature) now points at the live story specs (`005-retention`, `foundation.md`, `003-sessions`).
