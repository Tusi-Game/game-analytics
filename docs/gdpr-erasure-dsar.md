# GDPR/CCPA erasure & DSAR (ops-envelope §7 / §9)

> Mechanism: `src/gdpr/erasure.service.ts` (four-tier job) +
> `src/gdpr/dsar.service.ts` (Art. 15/20 export). Cross-story spine work is
> delegated via `src/gdpr/erasure.ports.ts` (later specs bind real
> implementations). Config knobs in `GAME.config` (T-00.79).

## Four-tier erasure posture (Q7)

One idempotent job. SLA ≤ 30 days hard (Art. 12(3)), typically ≤ 4 days.

- **Tier (a) — HARD DELETE / scrub (ops-envelope §7.1).** Delete `USER_SPINE`
  (last), `PAYER_SPINE_EXT`, `PAYER_PERIOD_SPEND`, `BALANCE_SNAPSHOT`; scrub
  `user_id` from `ACTIVE_USER_DAY.members` / `PAYER_DAY.payer_members` for the
  enumerated days; **DETACH** `PURCHASE_IDEMPOTENCY` (tombstone `user_id`, keep
  money fields — Art. 17(3)(b), keeps the durable money dedup intact) per
  `erasure_purchase_mode`. In **002 scope** these tables do not exist yet, so
  tier (a) is delegated to `TierADeletionPort` (later specs implement it); 002
  itself hard-deletes the operational `IDENTITY_EDGE` (it holds `user_id`).
- **Tier (b) — LEAVE UNTOUCHED (§7.2).** Never recompute sealed aggregate cells
  (`EVENT_DAY_COUNT`, `EVENT_CATALOG`, `EXCEPTION_TALLY`, and later stories'
  result cells) — they hold no per-user identifier once membership is scrubbed;
  aggregate statistics under Recital 26, sheltered by Art. 17(3)(d)/89(1).
  Recomputing would violate the seal invariant AND is legally unnecessary. The
  job simply never touches them.
- **Tier (c) — raw expiry + ledger-refilter (§7.3).** Sealed S3 objects are never
  rewritten on the hot path. `raw_retention_days` (default 90; ≤ 30 = strictest)
  expires them. **Every manual raw rebuild MUST re-apply the `ERASURE_LEDGER` as a
  filter:** for each replayed envelope compute the per-game keyed
  `subject_ref = HMAC(per-game-key, user_id)` and skip on an `executed` match.
  Optional `strict_raw_rewrite` offline tool (default off) rewrites objects.
- **Tier (d) — Redis self-erasure by TTL (§7.4).** No Redis deletion code — the
  destructive pass runs only after every active day seals, by which time
  membership is landed+scrubbed in Postgres and the remaining Redis copies expire
  on their own TTLs.

## `subject_ref` scheme (never plaintext)

`ERASURE_LEDGER.subject_ref = HMAC-SHA256(key = per-game key, msg = user_id)`,
hex (`src/security/subject-hash.service.ts`). Deterministic (recomputable for
rebuild filtering) + keyed per-game (the ledger can't be brute-forced back to a
user_id → not "a spine of erased people", Art. 11). The per-game key is derived
from the OUT-OF-DB master key (`SECRET_MASTER_KEY`) + `game_id`; a DB dump yields
only hashes. Key-separation is what makes the keyed hash lawful pseudonymization.

## Job op-order (idempotent)

1. Verify → ledger `pending` (with `subject_ref`).
2. **Read the activity/payer days FIRST** (before anything deletes the bitmap).
3. Any enumerated day unsealed → park `awaiting_seal`, re-evaluate ≤ 72 h.
4. Destructive pass (all sealed): tier (a) delete/scrub/detach + `IDENTITY_EDGE`
   delete; tiers (b)/(c)/(d) as above.
5. Ledger → `executed` + `executed_at`.

Re-runs are no-ops on absent rows/members; an `executed` request returns
immediately (never re-runs the destructive pass).

## Reconcile-forward-only + re-appearance (§7.6)

Stored sealed cells are the post-erasure truth; a spine re-scan / raw rebuild
reads *below* them and must NEVER "correct" a sealed cell downward. A re-appearing
`user_id` is a NEW subject by construction — no denylist, the ledger hash is never
consulted at ingest.

## DSAR access (Art. 15/20, §9)

`DsarService.assemble(gameId, userId)` — read-only export of the subject's
personal data: `active_days_bitmap` + `PAYER_SPINE_EXT` + `PAYER_PERIOD_SPEND` +
`PURCHASE_IDEMPOTENCY` (+ `IDENTITY_EDGE`), delegated to `DsarExportPort` for the
spine family (002 provides `IDENTITY_EDGE`). Aggregate cells are OUT of scope
(Art. 11 / Recital 26) and the export says so. The admin surface that triggers
and downloads it is 011's.

## Config knobs (T-00.79, `GAME.config`, forward-only)

| Knob | Default | Semantics |
|---|---|---|
| `raw_retention_days` | 90 | S3-side raw expiry; ≤ 30 = strictest |
| `erasure_purchase_mode` | `detach` | `detach` (keep money dedup) / `delete` |
| `strict_raw_rewrite` | off | enable the offline raw-rewrite tool |
