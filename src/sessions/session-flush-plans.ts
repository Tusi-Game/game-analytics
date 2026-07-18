/**
 * Flush plans + merge specs for the `sess` / `act` / `ret` domains (T-02.22,
 * T-04.18, Foundation §3.2/§3.2.1). Each plan projects a drained Redis bucket's
 * absolute hash into {@link FlushRow}s the shared {@link buildFlushStatement}
 * engine upserts idempotently under the per-class merge rule.
 *
 *   sess (class M) → SESSION_DAY_RESULT  (session_count / duration_sum_ms /
 *                    sessions_touching all GREATEST)
 *   act  (class S) → ACTIVE_USER_DAY.members (jsonb set-union — NEVER blind
 *                    replace; the bucket is a HASH-as-set, fields = user_ids)
 *   ret  (class M) → COHORT.cohort_size (from `size`) + RETENTION_CELL.retained_users
 *                    (from each `cell:{c}:{off}` field; bucket day = activity day)
 *
 * Every merge is a no-op on retry by construction (class M GREATEST / class S
 * union of a contained set). Deltas NEVER flush — only current absolutes.
 */

import type { DomainFlushPlan, FlushRow, MergeTableSpec } from '../workers/flush/flush.service';
import { SEEDED_MARKER_FIELD } from '../common/redis-keys/rehydrate';
import { dayScopedKey } from '../common/redis-keys/redis-keys';
import {
  SESS_FIELD_SESSION_COUNT,
  SESS_FIELD_DURATION_SUM_MS,
  SESS_FIELD_SESSIONS_TOUCHING,
  RET_FIELD_SIZE,
  parseRetCellField,
} from './session-keys';

// ---------------------------------------------------------------------------
// Merge specs (fixed per structure, Foundation §3.2.1).
// ---------------------------------------------------------------------------

export const SESSION_MERGE_SPECS = {
  /** SESSION_DAY_RESULT — three class-M (GREATEST) counters. */
  sessionDayResult: {
    table: 'session_day_result',
    pkColumns: ['game_id', 'utc_day'],
    valueColumns: [
      { column: 'session_count', rule: 'greatest' },
      { column: 'duration_sum_ms', rule: 'greatest' },
      { column: 'sessions_touching', rule: 'greatest' },
    ],
  } satisfies MergeTableSpec,

  /** ACTIVE_USER_DAY.members — class S (jsonb set-union). */
  activeUserDay: {
    table: 'active_user_day',
    pkColumns: ['game_id', 'utc_day'],
    valueColumns: [{ column: 'members', rule: 'set-union' }],
  } satisfies MergeTableSpec,

  /** COHORT.cohort_size — class M (GREATEST). */
  cohort: {
    table: 'cohort',
    pkColumns: ['game_id', 'cohort_date'],
    valueColumns: [{ column: 'cohort_size', rule: 'greatest' }],
  } satisfies MergeTableSpec,

  /** RETENTION_CELL.retained_users — class M (GREATEST). */
  retentionCell: {
    table: 'retention_cell',
    pkColumns: ['game_id', 'cohort_date', 'day_offset'],
    valueColumns: [{ column: 'retained_users', rule: 'greatest' }],
  } satisfies MergeTableSpec,
} as const;

// ---------------------------------------------------------------------------
// Key parsing (the bucket key carries the game_id + day the projector needs).
// ---------------------------------------------------------------------------

/** Parse a `{game_id}:{domain}:{day}` day-scoped bucket key. */
function parseDayScoped(bucketKey: string, domain: string): { gameId: string; day: string } | null {
  const parts = bucketKey.split(':');
  if (parts.length !== 3) {
    return null;
  }
  const [gameId, dom, day] = parts;
  if (dom !== domain || gameId === undefined || day === undefined) {
    return null;
  }
  return { gameId, day };
}

// ---------------------------------------------------------------------------
// Projectors.
// ---------------------------------------------------------------------------

/** `sess` hash → one SESSION_DAY_RESULT row (all three counters, absolute). */
function projectSess(bucketKey: string, hash: Record<string, string>): FlushRow[] {
  const parsed = parseDayScoped(bucketKey, 'sess');
  if (!parsed) {
    return [];
  }
  return [
    {
      pk: { game_id: parsed.gameId, utc_day: parsed.day },
      values: {
        session_count: hash[SESS_FIELD_SESSION_COUNT] ?? '0',
        duration_sum_ms: hash[SESS_FIELD_DURATION_SUM_MS] ?? '0',
        sessions_touching: hash[SESS_FIELD_SESSIONS_TOUCHING] ?? '0',
      },
    },
  ];
}

/**
 * `act` HASH-as-set → one ACTIVE_USER_DAY row. `members` is emitted as a jsonb
 * OBJECT map (`{ "<user_id>": true }`) so the class-S flush merges by jsonb `||`
 * object-union (idempotent, no duplicate accumulation). The Redis hash field-names
 * ARE the user_ids (the seeded marker is stripped by the flusher before projection).
 */
function projectAct(bucketKey: string, hash: Record<string, string>): FlushRow[] {
  const parsed = parseDayScoped(bucketKey, 'act');
  if (!parsed) {
    return [];
  }
  const members: Record<string, true> = {};
  for (const userId of Object.keys(hash)) {
    members[userId] = true;
  }
  return [
    {
      pk: { game_id: parsed.gameId, utc_day: parsed.day },
      values: { members },
    },
  ];
}

/** `ret` hash → COHORT row (from `size`), keyed on the bucket day = cohort day. */
function projectRetCohort(bucketKey: string, hash: Record<string, string>): FlushRow[] {
  const parsed = parseDayScoped(bucketKey, 'ret');
  if (!parsed) {
    return [];
  }
  const size = hash[RET_FIELD_SIZE];
  if (size === undefined) {
    return [];
  }
  // The bucket day IS the cohort day for the `size` field (cohort born this day).
  return [{ pk: { game_id: parsed.gameId, cohort_date: parsed.day }, values: { cohort_size: size } }];
}

/** `ret` hash → RETENTION_CELL rows (one per `cell:{c}:{off}` field). */
function projectRetCells(bucketKey: string, hash: Record<string, string>): FlushRow[] {
  const parsed = parseDayScoped(bucketKey, 'ret');
  if (!parsed) {
    return [];
  }
  const rows: FlushRow[] = [];
  for (const [field, value] of Object.entries(hash)) {
    if (field === SEEDED_MARKER_FIELD || field === RET_FIELD_SIZE) {
      continue;
    }
    const cell = parseRetCellField(field);
    if (!cell) {
      continue;
    }
    rows.push({
      pk: { game_id: parsed.gameId, cohort_date: cell.cohortDate, day_offset: cell.offset },
      values: { retained_users: value },
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Plans (registered with FlushJobService via EXTRA_DOMAIN_FLUSH_PLANS).
// Multiple plans MAY share one domain — `ret` drains once and both the COHORT and
// RETENTION_CELL plans run over the same drained batch (mirrors 002's cnt/exc).
// ---------------------------------------------------------------------------

export const SESS_FLUSH_PLAN: DomainFlushPlan = {
  domain: 'sess',
  spec: SESSION_MERGE_SPECS.sessionDayResult,
  project: projectSess,
};

export const ACT_FLUSH_PLAN: DomainFlushPlan = {
  domain: 'act',
  spec: SESSION_MERGE_SPECS.activeUserDay,
  project: projectAct,
};

export const RET_COHORT_FLUSH_PLAN: DomainFlushPlan = {
  domain: 'ret',
  spec: SESSION_MERGE_SPECS.cohort,
  project: projectRetCohort,
};

export const RET_CELL_FLUSH_PLAN: DomainFlushPlan = {
  domain: 'ret',
  spec: SESSION_MERGE_SPECS.retentionCell,
  project: projectRetCells,
};

/** Key builders re-exported for the read model / tests (byte-identical spelling). */
export const sessBucketKey = (gameId: string, day: string): string => dayScopedKey(gameId, 'sess', day);
export const actBucketKey = (gameId: string, day: string): string => dayScopedKey(gameId, 'act', day);
export const retBucketKey = (gameId: string, day: string): string => dayScopedKey(gameId, 'ret', day);
