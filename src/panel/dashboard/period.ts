/**
 * Panel period model (spec §1 Routing, §2.3) — parses the `?period=` query into a
 * concrete inclusive day window `[from, to]` plus the immediately-preceding
 * equal-length window `[prevFrom, prevTo]` (for trend deltas, T-11.26). All days
 * are "YYYY-MM-DD" UTC-logical strings, matching the read services' grammar.
 *
 * Pure — no I/O. The read services own the live-vs-sealed merge; this only maps a
 * UI selection to day ranges.
 */

/** The supported period presets (spec §2.3 period-selector). */
export const PERIOD_PRESETS = ['24h', '7d', '30d', '90d'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

/** A resolved period: the window, its preceding equal-length window, and metadata. */
export interface ResolvedPeriod {
  preset: PeriodPreset | 'custom';
  /** Number of days in the window (inclusive). */
  days: number;
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  /** True iff the window includes today (⇒ figures are provisional). */
  includesToday: boolean;
}

const PRESET_DAYS: Record<PeriodPreset, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };
const MS_PER_DAY = 86_400_000;

function toDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function dayToMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/** True iff the string is a well-formed "YYYY-MM-DD". */
export function isDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Resolve a period selection into concrete day windows.
 * - a preset (`7d`/…) ends today and spans `days` days;
 * - `custom` with valid `from`/`to` uses that inclusive window;
 * - anything unrecognized falls back to the default preset (`7d`).
 */
export function resolvePeriod(
  periodParam: string | undefined,
  fromParam: string | undefined,
  toParam: string | undefined,
  now: number = Date.now(),
): ResolvedPeriod {
  const todayDay = toDay(now);

  if (periodParam === 'custom' && isDay(fromParam) && isDay(toParam) && fromParam <= toParam) {
    const days = Math.round((dayToMs(toParam) - dayToMs(fromParam)) / MS_PER_DAY) + 1;
    return withPrev('custom', days, fromParam, toParam, todayDay);
  }

  const preset: PeriodPreset = (PERIOD_PRESETS as readonly string[]).includes(periodParam ?? '')
    ? (periodParam as PeriodPreset)
    : '7d';
  const days = PRESET_DAYS[preset];
  const from = toDay(now - (days - 1) * MS_PER_DAY);
  return withPrev(preset, days, from, todayDay, todayDay);
}

function withPrev(
  preset: PeriodPreset | 'custom',
  days: number,
  from: string,
  to: string,
  todayDay: string,
): ResolvedPeriod {
  const prevTo = toDay(dayToMs(from) - MS_PER_DAY);
  const prevFrom = toDay(dayToMs(from) - days * MS_PER_DAY);
  return {
    preset,
    days,
    from,
    to,
    prevFrom,
    prevTo,
    includesToday: from <= todayDay && todayDay <= to,
  };
}

/** Inclusive list of "YYYY-MM-DD" days for a window (capped for safety). */
export function enumeratePeriodDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let t = dayToMs(from); t <= dayToMs(to) && days.length < 400; t += MS_PER_DAY) {
    days.push(toDay(t));
  }
  return days;
}
