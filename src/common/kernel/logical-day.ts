/**
 * Platform logical day (foundation §4.7) — CORRECTNESS-BEARING.
 *
 *   logical_day(t) = utc_day(t + reporting_offset)
 *
 * A single platform-level `reporting_offset` (minutes, default 0/UTC) defines
 * the day used by EVERY time-bucketed structure AND every seal boundary. It is a
 * rigid translation of the whole time axis, applied EXACTLY ONCE at the day
 * floor — never re-applied at display (§4.7).
 *
 * DARK-SPOT #4 — the three bucketing rules are DIFFERENT timestamps and must
 * never be mixed. They are written here as three DISTINCT, explicitly-named
 * functions so a caller cannot silently pick the wrong one:
 *
 *   - {@link eventBucketDay}    — normal accepted events bucket on CORRECTED time.
 *   - {@link fallbackBucketDay} — time_fallback events (unusable client times)
 *                                 bucket on SERVER-RECEIVED time.
 *   - {@link arrivalBucketDay}  — EXCEPTION_TALLY buckets on the ARRIVAL day
 *                                 (server-received) — when the platform observed
 *                                 the problem, not the event's own day.
 *
 * `reporting_offset` is applied inside {@link logicalDay} and nowhere else, so
 * double-application is structurally impossible: every bucket function funnels
 * through the single `logicalDay` primitive.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * 60_000;

/**
 * Format a UTC epoch-ms instant as a `YYYY-MM-DD` calendar day in UTC.
 * Pure UTC — the offset is NOT applied here; callers apply it via
 * {@link logicalDay} so the offset lives in exactly one place.
 */
export function utcDay(epochMs: number): string {
  if (!Number.isFinite(epochMs)) {
    throw new Error(`[logical-day] utcDay requires a finite epoch-ms, got ${epochMs}`);
  }
  // Floor to the day boundary in UTC, then format. Using arithmetic (not
  // Date.toISOString slicing on the raw instant) keeps negative epochs correct.
  const dayIndex = Math.floor(epochMs / MS_PER_DAY);
  const midnightUtc = dayIndex * MS_PER_DAY;
  return new Date(midnightUtc).toISOString().slice(0, 10);
}

/**
 * The platform logical day for an instant, applying `reporting_offset` ONCE.
 * This is the SINGLE place the offset touches a timestamp; every bucket helper
 * routes through it, so "applied twice" cannot happen by construction.
 *
 * @param epochMs        instant (UTC epoch ms) to bucket.
 * @param reportingOffsetMinutes platform offset in MINUTES (e.g. 210 for +03:30).
 */
export function logicalDay(epochMs: number, reportingOffsetMinutes: number): string {
  if (!Number.isInteger(reportingOffsetMinutes)) {
    throw new Error(`[logical-day] reporting_offset must be an integer minute count, got ${reportingOffsetMinutes}`);
  }
  return utcDay(epochMs + reportingOffsetMinutes * MS_PER_MINUTE);
}

/**
 * The UTC-epoch-ms of the START of the logical day that `epochMs` falls in.
 * Used by the seal clock (§2.3): the seal boundary is `dayEnd + grace`, and
 * `dayEnd` is this floor plus 24 h. The offset is applied once via
 * {@link logicalDay}'s translation and then removed, so the returned instant is
 * a true UTC epoch (raw storage stays UTC — §4.7).
 */
export function logicalDayStartUtcMs(epochMs: number, reportingOffsetMinutes: number): number {
  const offsetMs = reportingOffsetMinutes * MS_PER_MINUTE;
  // Shift into offset-space, floor to the offset-local midnight, shift back to UTC.
  const shifted = epochMs + offsetMs;
  const localMidnight = Math.floor(shifted / MS_PER_DAY) * MS_PER_DAY;
  return localMidnight - offsetMs;
}

/**
 * The UTC-epoch-ms of the END of the logical day that `epochMs` falls in
 * (i.e. the start of the NEXT logical day). This is `D_end` in §2.3.
 */
export function logicalDayEndUtcMs(epochMs: number, reportingOffsetMinutes: number): number {
  return logicalDayStartUtcMs(epochMs, reportingOffsetMinutes) + MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// The three DISTINCT bucketing rules (DARK-SPOT #4). Each names its timestamp
// source in the signature so a caller reads exactly which day it buckets on.
// ---------------------------------------------------------------------------

/**
 * Normal accepted event → bucket on the CORRECTED (skew-corrected) time.
 * Feeds `cnt` / `cat` / every result cell for an accepted event (§4.2).
 */
export function eventBucketDay(correctedTimeMs: number, reportingOffsetMinutes: number): string {
  return logicalDay(correctedTimeMs, reportingOffsetMinutes);
}

/**
 * `time_fallback` event (client times unusable → sanity clamp fired) → bucket on
 * the SERVER-RECEIVED time, not the untrusted corrected time (§4.2 guard 1).
 * The event is still ACCEPTED; only its bucket day differs.
 */
export function fallbackBucketDay(serverReceivedTimeMs: number, reportingOffsetMinutes: number): string {
  return logicalDay(serverReceivedTimeMs, reportingOffsetMinutes);
}

/**
 * EXCEPTION_TALLY → bucket on the ARRIVAL day = the SERVER-RECEIVED time (§1.2,
 * §4.4). A tally records WHEN the platform observed the problem, so it is keyed
 * on arrival, never on the event's own corrected day.
 */
export function arrivalBucketDay(serverReceivedTimeMs: number, reportingOffsetMinutes: number): string {
  return logicalDay(serverReceivedTimeMs, reportingOffsetMinutes);
}
