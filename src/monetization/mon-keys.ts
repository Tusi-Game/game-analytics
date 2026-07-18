/**
 * Redis key + hash-field builders for the `mon` / `payer` / `rev` / `stage` domains
 * ([006-monetization] design "Redis structures"). All keys route through the shared
 * grammar helpers ({@link dayScopedKey}/{@link dayLessKey}) so they are byte-identical
 * across writer, flusher and read model, and the domain-palette collision guard
 * (Foundation §2.1) fires on any typo.
 *
 * Grammar (Foundation §2.1):
 *   {game_id}:mon:{logical_day}:cnt    hash — cell key → purchase_count (class N)
 *   {game_id}:mon:{logical_day}:rev    hash — cell key → normalized revenue (class N)
 *   {game_id}:mon:{logical_day}:loc    hash — `{cell key}#{currency}` → local sum (class N)
 *   {game_id}:mon:{logical_day}:meta   hash — `gen` monotonic generation gate (class N)
 *   {game_id}:mon:dimcard:{dim}        set  — per-dimension observed-value registry (cap)
 *   {game_id}:payer:{logical_day}      set  — distinct payer user_ids (class S)
 *   {game_id}:rev:{logical_day}        hash — `total` + `loc:{currency}` day sums (class N)
 *   {game_id}:stage:{purchase_attempt_id} hash — companion-join staging (srv/cmp fields)
 *
 * ============================ FIELD ENCODING =============================
 * The rollup cell KEY inside the mon hashes = `{product_id}#{dim_combo}` — `#` is the
 * separator because `dim_combo` uses `|` internally and product ids are sanitized of
 * `#`. The `loc` hash appends `#{currency}` for the per-currency local sum.
 */

import { dayScopedKey, dayLessKey } from '../common/redis-keys/redis-keys';

/** Cell-key separator (between product_id and dim_combo). */
export const CELL_SEP = '#';

export const MonKeys = {
  /** `{game_id}:mon:{day}:cnt` — cell → purchase_count (class N). */
  cnt: (gameId: string, day: string): string => dayScopedKey(gameId, 'mon', day, 'cnt'),
  /** `{game_id}:mon:{day}:rev` — cell → normalized revenue (class N). */
  rev: (gameId: string, day: string): string => dayScopedKey(gameId, 'mon', day, 'rev'),
  /** `{game_id}:mon:{day}:loc` — `{cell}#{currency}` → local sum (class N). */
  loc: (gameId: string, day: string): string => dayScopedKey(gameId, 'mon', day, 'loc'),
  /** `{game_id}:mon:{day}:meta` — `gen` generation gate (class N). */
  meta: (gameId: string, day: string): string => dayScopedKey(gameId, 'mon', day, 'meta'),
  /** `{game_id}:mon:{day}:cat` — cell → product_category (non-key carried alongside). */
  cat: (gameId: string, day: string): string => dayScopedKey(gameId, 'mon', day, 'cat'),
  /** `{game_id}:mon:dimcard:{dim}` — per-dimension observed-value registry set. */
  dimCard: (gameId: string, dim: string): string => dayLessKey(gameId, 'mon', 'dimcard', dim),
} as const;

/** The `gen` field name inside the `:meta` hash. */
export const META_GEN_FIELD = 'gen';

export const PayerKeys = {
  /** `{game_id}:payer:{day}` — distinct payer user_ids (class S set). */
  members: (gameId: string, day: string): string => dayScopedKey(gameId, 'payer', day),
} as const;

/** `rev` day-total hash field names. */
export const REV_TOTAL_FIELD = 'total';
/** Prefix for the per-currency day local sum in the `rev` hash: `loc:{currency}`. */
export const REV_LOC_PREFIX = 'loc';

export const RevKeys = {
  /** `{game_id}:rev:{day}` — `total` + `loc:{currency}` day sums (class N). */
  day: (gameId: string, day: string): string => dayScopedKey(gameId, 'rev', day),
} as const;

/** Build the `rev` per-currency field: `loc:{currency}`. */
export function revLocField(currency: string): string {
  return `${REV_LOC_PREFIX}:${currency}`;
}

export const StageKeys = {
  /** `{game_id}:stage:{purchase_attempt_id}` — companion-join staging hash. */
  stage: (gameId: string, purchaseAttemptId: string): string => dayLessKey(gameId, 'stage', purchaseAttemptId),
} as const;

// ---------------------------------------------------------------------------
// Cell-key encoding: `{product_id}#{dim_combo}`. product_id is sanitized of `#`.
// ---------------------------------------------------------------------------

/** Escape `#` in a product id so it can never forge the cell-key boundary. */
export function sanitizeProductId(productId: string): string {
  return productId.replace(/\\/g, '\\\\').replace(/#/g, '\\#');
}

/** Reverse {@link sanitizeProductId}. */
function unsanitizeProductId(productId: string): string {
  let out = '';
  for (let i = 0; i < productId.length; i += 1) {
    if (productId[i] === '\\' && i + 1 < productId.length) {
      out += productId[i + 1];
      i += 1;
    } else {
      out += productId[i];
    }
  }
  return out;
}

/** Build the mon cell key `{product_id}#{dim_combo}`. */
export function cellKey(productId: string, dimCombo: string): string {
  return `${sanitizeProductId(productId)}${CELL_SEP}${dimCombo}`;
}

/** Parse a mon cell key back into (product_id, dim_combo), or null if malformed. */
export function parseCellKey(key: string): { productId: string; dimCombo: string } | null {
  // Find the first UN-escaped `#` (the product↔dim boundary).
  for (let i = 0; i < key.length; i += 1) {
    if (key[i] === '\\') {
      i += 1;
      continue;
    }
    if (key[i] === CELL_SEP) {
      return {
        productId: unsanitizeProductId(key.slice(0, i)),
        dimCombo: key.slice(i + 1),
      };
    }
  }
  return null;
}

/** Build the `loc` hash field `{cell key}#{currency}`. */
export function locField(cellKeyStr: string, currency: string): string {
  return `${cellKeyStr}${CELL_SEP}${currency}`;
}

/**
 * Parse a `loc` hash field back into (cell key, currency). The currency is the last
 * `#`-delimited segment; the cell key is everything before it (which itself contains
 * exactly one UN-escaped `#` between product and dim_combo). Currencies are ISO codes
 * with no `#`, so splitting on the LAST `#` is unambiguous.
 */
export function parseLocField(field: string): { cellKey: string; currency: string } | null {
  const idx = field.lastIndexOf(CELL_SEP);
  if (idx <= 0 || idx === field.length - 1) {
    return null;
  }
  return { cellKey: field.slice(0, idx), currency: field.slice(idx + 1) };
}

/** Parse a `{game_id}:mon:{day}:{cnt|rev|loc|meta|cat}` key into (gameId, day, kind). */
export function parseMonBucketKey(bucketKey: string): { gameId: string; day: string; kind: string } | null {
  const parts = bucketKey.split(':');
  if (parts.length === 4 && parts[1] === 'mon') {
    return { gameId: parts[0]!, day: parts[2]!, kind: parts[3]! };
  }
  return null;
}

/** Parse a `{game_id}:payer:{day}` key into (gameId, day). */
export function parsePayerBucketKey(bucketKey: string): { gameId: string; day: string } | null {
  const parts = bucketKey.split(':');
  if (parts.length === 3 && parts[1] === 'payer') {
    return { gameId: parts[0]!, day: parts[2]! };
  }
  return null;
}

/** Parse a `{game_id}:rev:{day}` key into (gameId, day). */
export function parseRevBucketKey(bucketKey: string): { gameId: string; day: string } | null {
  const parts = bucketKey.split(':');
  if (parts.length === 3 && parts[1] === 'rev') {
    return { gameId: parts[0]!, day: parts[2]! };
  }
  return null;
}
