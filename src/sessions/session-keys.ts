/**
 * Redis key + field builders for the `sess` / `act` / `ret` domains ([003-sessions]
 * + [005-retention] design Redis tables). All route through the shared grammar
 * helpers ({@link dayScopedKey}) so keys are byte-identical across writer, flusher
 * and read model, and the domain-palette collision guard (Foundation §2.1) fires
 * on any typo.
 *
 * Grammar (Foundation §2.1):
 *   {game_id}:sess:{logical_day}   hash  — session_count / duration_sum_ms / sessions_touching
 *   {game_id}:act:{logical_day}    set   — user_ids with a session START that day
 *   {game_id}:ret:{logical_day}    hash  — cell:{cohort}:{offset} + size (BUCKET-DAY rule)
 *
 * The `ret` hash is keyed on the ACTIVITY day `d = cohort_date + offset`, not the
 * cohort day (the bucket-day rule, T-04.14). A field `cell:{c}:{N}` in bucket `d`
 * means `c + N == d`; `size` in bucket `d` is the cohort born on day `d`.
 */

import { dayScopedKey } from '../common/redis-keys/redis-keys';

/** `sess` hash fields ([003-sessions] design Redis table). */
export const SESS_FIELD_SESSION_COUNT = 'session_count';
export const SESS_FIELD_DURATION_SUM_MS = 'duration_sum_ms';
export const SESS_FIELD_SESSIONS_TOUCHING = 'sessions_touching';

/** `ret` hash: the running cohort size for the cohort born on the bucket day. */
export const RET_FIELD_SIZE = 'size';
/** Prefix for a `ret` retention-cell field (`cell:{cohort_date}:{offset}`). */
export const RET_CELL_PREFIX = 'cell:';

export const SessionKeys = {
  /** `{game_id}:sess:{logical_day}` — per-day session aggregate hash (class M). */
  sess: (gameId: string, logicalDay: string): string => dayScopedKey(gameId, 'sess', logicalDay),
  /** `{game_id}:act:{logical_day}` — per-day active-user set (class S). */
  act: (gameId: string, logicalDay: string): string => dayScopedKey(gameId, 'act', logicalDay),
  /** `{game_id}:ret:{logical_day}` — per-ACTIVITY-day retention hash (class M). */
  ret: (gameId: string, logicalDay: string): string => dayScopedKey(gameId, 'ret', logicalDay),
} as const;

/** Build a `ret` cell field name: `cell:{cohort_date}:{offset}`. */
export function retCellField(cohortDate: string, offset: number): string {
  return `${RET_CELL_PREFIX}${cohortDate}:${offset}`;
}

/** Parsed parts of a `ret` cell field, or null if it is not a `cell:*` field. */
export interface RetCell {
  cohortDate: string;
  offset: number;
}

/**
 * Parse a `ret` hash field back into a retention cell. Returns null for `size` or
 * any non-cell field. `cohort_date` is a `YYYY-MM-DD` (no `:`), so splitting the
 * `cell:` remainder on its LAST `:` recovers the offset.
 */
export function parseRetCellField(field: string): RetCell | null {
  if (!field.startsWith(RET_CELL_PREFIX)) {
    return null;
  }
  const rest = field.slice(RET_CELL_PREFIX.length);
  const lastColon = rest.lastIndexOf(':');
  if (lastColon <= 0) {
    return null;
  }
  const cohortDate = rest.slice(0, lastColon);
  const offset = Number(rest.slice(lastColon + 1));
  if (!Number.isInteger(offset) || offset < 0) {
    return null;
  }
  return { cohortDate, offset };
}
