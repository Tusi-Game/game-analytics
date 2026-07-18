/**
 * Canonical `dim_combo` encoding ([006-monetization] design "dim_combo — canonical
 * encoding"). The rollup cell key component that segments revenue by the game's active
 * dimension set.
 *
 * RULES (all load-bearing — a stable cell key across a config REORDER depends on them):
 *  - every active dimension appears EXACTLY ONCE;
 *  - in FIXED LEXICOGRAPHIC ORDER OF DIMENSION NAME (never config-declaration order —
 *    reordering `monetization_dimensions` must not re-key cells);
 *  - rendered `name=value`, `|`-joined;
 *  - an unresolvable value is the literal `unknown` (never omitted);
 *  - a client value over the per-dimension cardinality budget collapses to the literal
 *    `other` (cardinality-guard.ts; `other` ≠ `unknown` — supplied-but-over-budget vs
 *    not-supplied);
 *  - values are SANITIZED — the delimiters `|` and `=` are escaped so a value
 *    containing them can never break the encoding or forge a second component.
 *
 * Example: `in_game_state=out_of_energy|region=EU`.
 */

/** The literal for a dimension whose value was not supplied / not resolvable. */
export const UNKNOWN_VALUE = 'unknown';
/** The literal for a client value over the per-dimension cardinality budget. */
export const OTHER_VALUE = 'other';

/** The active monetization dimensions (a subset of these; config `monetization_dimensions`). */
export const ALL_DIMENSIONS = [
  'level_bucket',
  'region',
  'in_game_state',
  'payer_tier',
  'days_since_install',
  'sessions_before_purchase',
] as const;
export type Dimension = (typeof ALL_DIMENSIONS)[number];

/** Client-only dims (resolved from the companion; `unknown` when absent). */
export const CLIENT_DIMENSIONS: ReadonlySet<string> = new Set([
  'level_bucket',
  'region',
  'in_game_state',
  'sessions_before_purchase',
]);

/**
 * Server-derived dims (never client-supplied; `days_since_install` is server-wins from
 * first_seen; `payer_tier`/`install_cohort` from spine/06 state). Exempt from the
 * cardinality guard (bounded by construction).
 */
export const SERVER_DIMENSIONS: ReadonlySet<string> = new Set(['payer_tier', 'install_cohort', 'days_since_install']);

/**
 * Escape a value for the `name=value|…` grammar: backslash-escape the two structural
 * delimiters (`|`, `=`) and the escape char itself, so decode round-trips and a value
 * cannot forge a component boundary. `unknown`/`other` literals pass through unchanged
 * (they contain no delimiter).
 */
export function sanitizeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/=/g, '\\=');
}

/** Reverse {@link sanitizeValue}. */
export function unsanitizeValue(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '\\' && i + 1 < value.length) {
      out += value[i + 1];
      i += 1;
    } else {
      out += value[i];
    }
  }
  return out;
}

/**
 * Build the canonical dim_combo from a resolved (dimension → value) map over the
 * active dimension set. `activeDims` is the game's `monetization_dimensions`; every
 * one MUST have an entry in `resolved` (callers pass `unknown` for absent). Dimensions
 * are sorted by NAME (not declaration order); values are sanitized.
 */
export function buildDimCombo(activeDims: readonly string[], resolved: Readonly<Record<string, string>>): string {
  const parts: string[] = [];
  for (const dim of [...activeDims].sort()) {
    const raw = resolved[dim];
    const value = raw === undefined || raw === '' ? UNKNOWN_VALUE : raw;
    parts.push(`${dim}=${sanitizeValue(value)}`);
  }
  return parts.join('|');
}

/**
 * Parse a canonical dim_combo back into a (dimension → value) map. Splits on
 * UN-escaped `|`, then on the FIRST un-escaped `=`. Values are unsanitized. Malformed
 * components are skipped defensively (the encoder never produces them).
 */
export function parseDimCombo(dimCombo: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (dimCombo === '') {
    return out;
  }
  for (const component of splitUnescaped(dimCombo, '|')) {
    const eq = indexOfUnescaped(component, '=');
    if (eq <= 0) {
      continue;
    }
    const name = component.slice(0, eq);
    const value = unsanitizeValue(component.slice(eq + 1));
    out[name] = value;
  }
  return out;
}

/** True iff the dim_combo carries a `D=` component (read-time slice membership). */
export function dimComboHas(dimCombo: string, dimension: string): boolean {
  return dimension in parseDimCombo(dimCombo);
}

/** Split `s` on UN-escaped occurrences of the single-char `sep`. */
function splitUnescaped(s: string, sep: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length) {
      current += ch + s[i + 1]!;
      i += 1;
      continue;
    }
    if (ch === sep) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Index of the first UN-escaped `char` in `s`, or -1. */
function indexOfUnescaped(s: string, char: string): number {
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\\') {
      i += 1;
      continue;
    }
    if (s[i] === char) {
      return i;
    }
  }
  return -1;
}

/** Platform-default level-bucket boundaries (ascending level thresholds). */
export const DEFAULT_LEVEL_BUCKET_BOUNDARIES: readonly number[] = [10, 20, 30, 40, 50];

/**
 * Compute the `level_bucket` label for a raw `player_level` given ascending boundaries.
 * The raw level is NEVER stored — only this label. Buckets:
 *   level < b[0]              → `<b[0]`
 *   b[i] ≤ level < b[i+1]     → `b[i]-{b[i+1]-1}`
 *   level ≥ last boundary     → `{last}+`
 * Returns null when `playerLevel` is absent/non-numeric (skip the axis).
 */
export function computeLevelBucket(playerLevel: unknown, boundaries: readonly number[]): string | null {
  if (typeof playerLevel !== 'number' || !Number.isFinite(playerLevel)) {
    return null;
  }
  const level = Math.floor(playerLevel);
  if (boundaries.length === 0) {
    return `${level}`;
  }
  if (level < boundaries[0]!) {
    return `<${boundaries[0]}`;
  }
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    if (level >= boundaries[i]! && level < boundaries[i + 1]!) {
      return `${boundaries[i]}-${boundaries[i + 1]! - 1}`;
    }
  }
  return `${boundaries[boundaries.length - 1]}+`;
}
