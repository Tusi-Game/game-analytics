/**
 * 002's concrete flush PROJECTORS + plans (foundation §3.2) — the bridge between
 * a Redis hot bucket's hash and the absolute Postgres upsert. The merge SPECS
 * (M / mixed-cat) already live in {@link INGEST_MERGE_SPECS}; this module supplies
 * the projectors that turn a hash into {@link FlushRow}s for those specs.
 *
 * Three flushed structures 002 owns:
 *   - `cnt`     hash → EVENT_DAY_COUNT   (field = event_name → count; class M)
 *   - `cnt:exc` hash → EXCEPTION_TALLY   (field = reason → count; class M)
 *   - `cat`     hash → EVENT_CATALOG     (mixed per-field merge)
 *
 * `cnt` and `cnt:exc` share the `cnt` dirty-registry domain (both are
 * `{game_id}:cnt:{day}[:exc]` keys). {@link partitionCntBuckets} splits a drained
 * `cnt` batch by key shape so each half flushes under its own spec.
 */

import { INGEST_MERGE_SPECS } from './flush-merge';
import type { DomainFlushPlan, FlushRow } from './flush.service';
import { SEEDED_MARKER_FIELD } from '../../common/redis-keys/rehydrate';
import { CAT_FIELD_COUNT, CAT_FIELD_FIRST_SEEN, CAT_FIELD_LAST_SEEN } from '../kernel/postgres-floor.provider';
import { CAT_FIELD_EVENT_NAME, CAT_FIELD_GAME_ID, CAT_FIELD_KIND, CAT_PTS_PREFIX } from '../kernel/hot-bucket.writer';
import { EXC_FIELD_GAME_ID, EXC_FIELD_UTC_DAY } from '../kernel/exception-tally.writer';

/** Fields written for bookkeeping/rehydrate that are NOT flushable cells. */
const CNT_RESERVED = new Set<string>([SEEDED_MARKER_FIELD]);
const EXC_RESERVED = new Set<string>([SEEDED_MARKER_FIELD, EXC_FIELD_GAME_ID, EXC_FIELD_UTC_DAY]);
const CAT_RESERVED = new Set<string>([
  SEEDED_MARKER_FIELD,
  CAT_FIELD_COUNT,
  CAT_FIELD_FIRST_SEEN,
  CAT_FIELD_LAST_SEEN,
  CAT_FIELD_GAME_ID,
  CAT_FIELD_EVENT_NAME,
  CAT_FIELD_KIND,
]);

/** Parse a `{game_id}:cnt:{utc_day}` key back into its parts. */
function parseCntKey(bucketKey: string): { gameId: string; utcDay: string } | null {
  // Split on the LAST two `:` so a game_id containing… no colon (grammar forbids
  // `:` in a segment) means exactly 3 parts.
  const parts = bucketKey.split(':');
  const [gameId, domain, utcDay] = parts;
  if (parts.length !== 3 || domain !== 'cnt' || gameId === undefined || utcDay === undefined) {
    return null;
  }
  return { gameId, utcDay };
}

/** True iff a `cnt`-domain key is the exception-tally hash (`…:exc`). */
export function isExcBucket(bucketKey: string): boolean {
  return bucketKey.endsWith(':exc');
}

/** Split a drained `cnt` batch into plain day-count keys and exception keys. */
export function partitionCntBuckets(keys: string[]): { cntKeys: string[]; excKeys: string[] } {
  const cntKeys: string[] = [];
  const excKeys: string[] = [];
  for (const key of keys) {
    (isExcBucket(key) ? excKeys : cntKeys).push(key);
  }
  return { cntKeys, excKeys };
}

/** Projector: `cnt` hash → EVENT_DAY_COUNT rows (one per event_name field). */
function projectCnt(bucketKey: string, hash: Record<string, string>): FlushRow[] {
  const parsed = parseCntKey(bucketKey);
  if (!parsed) {
    return [];
  }
  const rows: FlushRow[] = [];
  for (const [field, value] of Object.entries(hash)) {
    if (CNT_RESERVED.has(field)) {
      continue;
    }
    rows.push({
      pk: { game_id: parsed.gameId, event_name: field, utc_day: parsed.utcDay },
      values: { count: value },
    });
  }
  return rows;
}

/** Projector: `cnt:exc` hash → EXCEPTION_TALLY rows (one per reason field). */
function projectExc(_bucketKey: string, hash: Record<string, string>): FlushRow[] {
  const gameId = hash[EXC_FIELD_GAME_ID];
  const utcDay = hash[EXC_FIELD_UTC_DAY];
  if (gameId === undefined || utcDay === undefined) {
    // Metadata not yet seeded → cannot build the PK; skip (will retry next sweep).
    return [];
  }
  const rows: FlushRow[] = [];
  for (const [field, value] of Object.entries(hash)) {
    if (EXC_RESERVED.has(field)) {
      continue;
    }
    rows.push({
      pk: { game_id: gameId, utc_day: utcDay, reason: field },
      values: { count: value },
    });
  }
  return rows;
}

/** Projector: `cat` hash → a single EVENT_CATALOG row (mixed-field merge). */
function projectCat(_bucketKey: string, hash: Record<string, string>): FlushRow[] {
  const gameId = hash[CAT_FIELD_GAME_ID];
  const eventName = hash[CAT_FIELD_EVENT_NAME];
  if (gameId === undefined || eventName === undefined) {
    return [];
  }
  // Reassemble property_type_sets from the per-key `pts:{key}` fields.
  const propertyTypeSets: Record<string, string[]> = {};
  for (const [field, value] of Object.entries(hash)) {
    if (!field.startsWith(CAT_PTS_PREFIX)) {
      continue;
    }
    const propKey = field.slice(CAT_PTS_PREFIX.length);
    try {
      const parsed: unknown = JSON.parse(value);
      propertyTypeSets[propKey] = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      propertyTypeSets[propKey] = [];
    }
  }
  const count = hash[CAT_FIELD_COUNT] ?? '0';
  const firstSeenMs = hash[CAT_FIELD_FIRST_SEEN];
  const lastSeenMs = hash[CAT_FIELD_LAST_SEEN];
  const kind = hash[CAT_FIELD_KIND] ?? 'generic';
  // first/last_seen columns are timestamptz — pass ISO strings the driver parses.
  return [
    {
      pk: { game_id: gameId, event_name: eventName },
      values: {
        lifetime_count: count,
        last_seen: lastSeenMs !== undefined ? new Date(Number(lastSeenMs)).toISOString() : null,
        first_seen: firstSeenMs !== undefined ? new Date(Number(firstSeenMs)).toISOString() : null,
        property_type_sets: propertyTypeSets,
        kind,
        status: 'accepted', // v1 catalog rows are always 'accepted'
      },
    },
  ];
}
// touch the reserved set so lint keeps it (documents intent even if unused here).
void CAT_RESERVED;

/** The plan flushing plain day-count `cnt` buckets → EVENT_DAY_COUNT. */
export const CNT_FLUSH_PLAN: DomainFlushPlan = {
  domain: 'cnt',
  spec: INGEST_MERGE_SPECS.eventDayCount,
  project: projectCnt,
};

/** The plan flushing `cnt:exc` buckets → EXCEPTION_TALLY. */
export const EXC_FLUSH_PLAN: DomainFlushPlan = {
  domain: 'cnt',
  spec: INGEST_MERGE_SPECS.exceptionTally,
  project: projectExc,
};

/** The plan flushing `cat` buckets → EVENT_CATALOG (mixed-field merge). */
export const CAT_FLUSH_PLAN: DomainFlushPlan = {
  domain: 'cat',
  spec: INGEST_MERGE_SPECS.eventCatalog,
  project: projectCat,
};
