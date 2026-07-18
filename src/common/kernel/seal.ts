/**
 * Day-seal check (foundation §2.3, §4.3) — pure.
 *
 * A logical day `D` is:
 *   - `open`   from its start until `D_end`;
 *   - `grace`  from `D_end` until `D_end + grace_window` (default 48 h) —
 *              still mutable, still counted;
 *   - `sealed` from `D_end + grace_window` onward — immutable; late events go to
 *              the raw quarantine tail + `sealed_late` tally, folded into
 *              NOTHING (§4.3).
 *
 * CRITICAL (§4.7 / §2.3): `D_end` is the end of the LOGICAL day — the seal clock
 * is shifted by the SAME `reporting_offset` as the day floor. We reuse the exact
 * `logicalDayEndUtcMs` primitive the bucketing uses, so the seal boundary and
 * the bucket boundary can never diverge.
 */

import { logicalDayEndUtcMs } from './logical-day';
import type { SealState } from '../contracts/queue-jobs';

export type { SealState };

/** Default post-`D_end` grace window before a day seals: 48 h (§2.3, §G). */
export const DEFAULT_GRACE_WINDOW_MS = 48 * 60 * 60_000;

/** Inputs to a seal check. All times are UTC epoch ms; offset is in minutes. */
export interface SealCheckInput {
  /** The event's CORRECTED time — its logical day is what we seal-check (§4.3). */
  correctedTime: number;
  /** Wall-clock "now" (epoch ms) at the moment the front door evaluates. */
  now: number;
  /** Platform reporting offset in minutes (shifts the seal clock uniformly). */
  reportingOffsetMinutes: number;
  /** Grace window in ms; defaults to {@link DEFAULT_GRACE_WINDOW_MS}. */
  graceWindowMs?: number;
}

/**
 * Compute the seal state of the corrected time's logical day as of `now`.
 * Boundaries are half-open: exactly at `D_end` the day enters `grace`; exactly
 * at `D_end + grace` it becomes `sealed`.
 */
export function checkSealState(input: SealCheckInput): SealState {
  const graceWindowMs = input.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS;
  // D_end of the event's LOGICAL day, offset-shifted — same primitive the
  // bucketing uses, so seal clock and bucket boundary move together.
  const dayEnd = logicalDayEndUtcMs(input.correctedTime, input.reportingOffsetMinutes);
  const sealAt = dayEnd + graceWindowMs;

  if (input.now >= sealAt) {
    return 'sealed';
  }
  if (input.now >= dayEnd) {
    return 'grace';
  }
  return 'open';
}

/** True iff the day is still mutable (open or in grace) — cells may be written. */
export function isMutable(state: SealState): boolean {
  return state === 'open' || state === 'grace';
}
