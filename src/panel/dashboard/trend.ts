/**
 * Trend-delta computation (spec §2.3, T-11.26) — the ONLY new read-time
 * derivation the panel adds on top of the read services' already-implemented §3.3
 * merge. Compares a current-period value against the immediately-preceding
 * equal-length period and renders a flat `—` when the change is under 1 %.
 *
 * Pure. `null` inputs (a masked N/A KPI) produce a flat trend — a trend against
 * an unknown baseline is meaningless.
 */

/** The direction + magnitude of a period-over-period change. */
export interface Trend {
  /** 'up' | 'down' | 'flat'. Flat when |change| < 1 % or a value is unknown. */
  direction: 'up' | 'down' | 'flat';
  /** Absolute percent change, rounded to one decimal; null when flat/undefined. */
  percent: number | null;
}

const FLAT: Trend = { direction: 'flat', percent: null };

/** Below this fractional change the trend renders flat `—` (spec §2.3: <1%). */
const FLAT_THRESHOLD = 0.01;

/**
 * Compute the trend of `current` vs `previous`. Flat when either is null, when
 * the previous baseline is 0 (an undefined ratio), or when |change| < 1 %.
 */
export function computeTrend(current: number | null, previous: number | null): Trend {
  if (current === null || previous === null || previous === 0) {
    return FLAT;
  }
  const change = (current - previous) / Math.abs(previous);
  if (Math.abs(change) < FLAT_THRESHOLD) {
    return FLAT;
  }
  return {
    direction: change > 0 ? 'up' : 'down',
    percent: Math.round(Math.abs(change) * 1000) / 10,
  };
}
