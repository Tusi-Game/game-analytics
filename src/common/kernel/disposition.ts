/**
 * Drop-vs-quarantine decision (foundation §4.4) — RECONCILED to R3.
 *
 * The front door produces exactly one {@link Disposition} per record, with the
 * tally reason that explains a non-route. Three outcomes (§3.1):
 *   - `route`      — accepted; hand to step 7/8.
 *   - `drop`       — refused BEFORE raw append; never appended. Reserved for
 *                    input that could never count: nameless / unparseable /
 *                    no-key-to-bucket-under / rate-limited.
 *   - `quarantine` — raw-appended WITH a marker but feeds NO counter/spine.
 *                    For recoverable-in-principle input: typed-invalid,
 *                    sealed-late, unknown_kind, time-fallback-borderline.
 *
 * R3 RECONCILIATION (the one live contradiction in 002): cardinality CAPS —
 * event-name cap, currency cap, client-dimension caps — are NOT drop-and-tally.
 * They OVERFLOW to a literal `other` bucket that is KEPT + counted (plan.md
 * R3, foundation §2.3 "observed-value cap + `other` overflow"). Drop-and-tally
 * (`nameless`/`unparseable`) is reserved ONLY for input with no key to bucket
 * under. `capexceeded` is therefore NOT a drop reason here — it is retired to an
 * other-overflow counter. This helper deliberately provides NO path that maps a
 * cap to a `drop`, so the stale drop-and-count posture cannot be reintroduced.
 */

import type { Disposition, FrontDoorVerdicts, SealState } from '../contracts/queue-jobs';
import type { ExceptionReason } from '../contracts/exception-reason';

export type { Disposition };

/**
 * Reasons that DROP a record (refused before raw append). A closed subset of
 * {@link ExceptionReason} — note the ABSENCE of `capexceeded` (R3: caps overflow
 * to `other`, they do not drop) and of any typed-validation reason (those
 * quarantine so the raw floor keeps them).
 */
export type DropReason = Extract<ExceptionReason, 'nameless' | 'unparseable' | 'rate_limited'>;

/**
 * Reasons that QUARANTINE a record (raw-appended + marker, tallied, feeds
 * nothing). Recoverable-in-principle from the raw floor.
 */
export type QuarantineReason = Extract<
  ExceptionReason,
  'quarantined_typed' | 'sealed_late' | 'unknown_kind' | 'time_fallback'
>;

const DROP_REASONS: ReadonlySet<DropReason> = new Set<DropReason>(['nameless', 'unparseable', 'rate_limited']);

const QUARANTINE_REASONS: ReadonlySet<QuarantineReason> = new Set<QuarantineReason>([
  'quarantined_typed',
  'sealed_late',
  'unknown_kind',
  'time_fallback',
]);

/** Build a `drop` verdict (never raw-appended). */
export function dropVerdict(reason: DropReason): FrontDoorVerdicts {
  return { dedup_passed: false, seal_state: 'open', disposition: 'drop', reason };
}

/** Build a `quarantine` verdict (raw-appended, feeds nothing). */
export function quarantineVerdict(reason: QuarantineReason, sealState: SealState = 'open'): FrontDoorVerdicts {
  return { dedup_passed: false, seal_state: sealState, disposition: 'quarantine', reason };
}

/** Build a `route` verdict for an accepted record. */
export function routeVerdict(sealState: SealState, dedupPassed: boolean): FrontDoorVerdicts {
  return { dedup_passed: dedupPassed, seal_state: sealState, disposition: 'route' };
}

/**
 * Map a non-route reason to its disposition. Encodes the §4.4 table exactly:
 * drop reasons → `drop`, quarantine reasons → `quarantine`. Throws on any reason
 * that belongs to neither set (e.g. `capexceeded`, which under R3 must never
 * reach this helper — a cap overflows to `other` upstream and the record
 * ROUTES).
 */
export function dispositionForReason(reason: ExceptionReason): Exclude<Disposition, 'route'> {
  if (DROP_REASONS.has(reason as DropReason)) {
    return 'drop';
  }
  if (QUARANTINE_REASONS.has(reason as QuarantineReason)) {
    return 'quarantine';
  }
  throw new Error(
    `[disposition] "${reason}" is neither a drop nor a quarantine reason. ` +
      'Cap-exceeded input overflows to the `other` bucket and ROUTES (R3) — it must not reach this helper.',
  );
}

/** True iff `reason` drops the record before raw append. */
export function isDropReason(reason: ExceptionReason): reason is DropReason {
  return DROP_REASONS.has(reason as DropReason);
}

/** True iff `reason` quarantines the record (raw-appended, feeds nothing). */
export function isQuarantineReason(reason: ExceptionReason): reason is QuarantineReason {
  return QUARANTINE_REASONS.has(reason as QuarantineReason);
}
