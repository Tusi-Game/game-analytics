/**
 * The single canonical declaration of every exception-tally reason (R5).
 *
 * Declared ONCE here and imported everywhere a reason is referenced — the
 * `EXCEPTION_TALLY` entity, the front-door verdict on {@link RoutedRecord}, and
 * every story that writes a tally. Do not re-declare this union anywhere else.
 *
 * The enum GROWS across specs, so the Postgres column is plain `text` (see
 * `EXCEPTION_TALLY`) — NEVER a Postgres enum type — and this TS union plus its
 * runtime companion `EXCEPTION_REASONS` are the sole source of truth. Adding a
 * reason means editing exactly this file.
 *
 * Foundation §1.2 / ER-full: the full v1 set of 12.
 */
export const EXCEPTION_REASONS = [
  'nameless',
  'unparseable',
  'capexceeded',
  'quarantined_typed',
  'sealed_late',
  'time_fallback',
  'negative_offset',
  'no_spine_row',
  'unknown_kind',
  'fx_stale_rate_used',
  'fx_unconverted',
  'rate_limited',
] as const;

/** Union of every valid exception-tally reason. */
export type ExceptionReason = (typeof EXCEPTION_REASONS)[number];

/** Runtime membership check that also narrows an `unknown` to `ExceptionReason`. */
export function isExceptionReason(value: unknown): value is ExceptionReason {
  return typeof value === 'string' && (EXCEPTION_REASONS as readonly string[]).includes(value);
}
