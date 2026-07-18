/**
 * Flush plans + merge specs for the `mon` / `payer` / `rev` domains ([006-monetization]
 * design "Redis structures" / Foundation §3.2.1). Two flush classes:
 *
 *   mon   (class N) → MONETIZATION_CELL — the cnt/rev/loc/cat data hashes + the meta
 *                     `gen` gate are snapshotted ATOMICALLY (flush.service ClassNFlushPlan)
 *                     so a MOVE's decrement+increment are both-in/both-out. GREATEST
 *                     FORBIDDEN — the gen guard (WHERE EXCLUDED.gen >= target.gen) is the
 *                     whole mechanism.
 *   rev   (class N) → PAYER_DAY.revenue_day_total — the day-total hash (`total` +
 *                     `loc:{currency}`) is class-N (FX recompute mutates it), gen-gated by
 *                     PAYER_DAY.gen (snapshotted with the mon meta gen — same day gen).
 *   payer (class S) → PAYER_DAY.payer_members — a Redis SET, class-S set-union (never
 *                     blind replace), via the plain DomainFlushPlan path.
 *
 * The `rev` day total shares PAYER_DAY's PK with `payer` — both upsert PAYER_DAY. They
 * flush independently: the class-S payer plan writes `payer_members` (guard-free union);
 * the class-N rev plan writes `revenue_day_total` gen-gated. Distinct value columns +
 * separate specs → no clobber (each ON CONFLICT DO UPDATE SET touches only its columns).
 */

import type { DomainFlushPlan, FlushRow, MergeTableSpec } from '../workers/flush/flush.service';
import type { ClassNFlushPlan } from '../workers/flush/flush.service';
import { SEEDED_MARKER_FIELD } from '../common/redis-keys/rehydrate';
import {
  MonKeys,
  RevKeys,
  parseCellKey,
  parseLocField,
  parseMonBucketKey,
  parsePayerBucketKey,
  parseRevBucketKey,
  REV_TOTAL_FIELD,
  REV_LOC_PREFIX,
} from './mon-keys';

// ---------------------------------------------------------------------------
// Merge specs (fixed per structure, Foundation §3.2.1).
// ---------------------------------------------------------------------------

export const MONETIZATION_MERGE_SPECS = {
  /** MONETIZATION_CELL — class N (gen-gated; GREATEST FORBIDDEN). */
  monetizationCell: {
    table: 'monetization_cell',
    pkColumns: ['game_id', 'product_id', 'dim_combo', 'utc_day'],
    valueColumns: [
      { column: 'purchase_count', rule: 'gen-gated' },
      { column: 'revenue_normalized', rule: 'gen-gated' },
      { column: 'revenue_local_breakdown', rule: 'gen-gated' },
      { column: 'product_category', rule: 'gen-gated' },
    ],
    guardColumn: 'gen',
  } satisfies MergeTableSpec,

  /** PAYER_DAY.revenue_day_total — class N (gen-gated; FX recompute mutates). */
  payerDayRevenue: {
    table: 'payer_day',
    pkColumns: ['game_id', 'utc_day'],
    valueColumns: [{ column: 'revenue_day_total', rule: 'gen-gated' }],
    guardColumn: 'gen',
  } satisfies MergeTableSpec,

  /** PAYER_DAY.payer_members — class S (set-union; never blind replace). */
  payerDayMembers: {
    table: 'payer_day',
    pkColumns: ['game_id', 'utc_day'],
    valueColumns: [{ column: 'payer_members', rule: 'set-union' }],
  } satisfies MergeTableSpec,
} as const;

// ---------------------------------------------------------------------------
// MONETIZATION_CELL — class-N atomic-snapshot plan (the `mon` domain).
// ---------------------------------------------------------------------------

/** Accumulator building one MONETIZATION_CELL row as the snapshot is scanned. */
interface CellAcc {
  pk: { game_id: string; product_id: string; dim_combo: string; utc_day: string };
  purchaseCount: string;
  revenueNormalized: string;
  productCategory: string;
  localBreakdown: Record<string, string>;
}

/**
 * Given a drained `mon` data-hash bucket (`…:cnt` / `:rev` / `:loc` / `:cat`), the meta
 * key + the FULL sibling data-hash set for that day. Draining any one sibling triggers a
 * single snapshot of all four + the gen (the flush service dedupes to one snapshot/day).
 */
function monRelatedKeys(bucketKey: string): { metaKey: string; dataKeys: readonly string[] } | null {
  const parsed = parseMonBucketKey(bucketKey);
  if (!parsed) {
    return null;
  }
  const { gameId, day, kind } = parsed;
  // Only the data-hash shapes trigger a cell snapshot; the meta hash itself is not a
  // data source (it is snapshotted as the gen).
  if (kind !== 'cnt' && kind !== 'rev' && kind !== 'loc' && kind !== 'cat') {
    return null;
  }
  return {
    metaKey: MonKeys.meta(gameId, day),
    dataKeys: [MonKeys.cnt(gameId, day), MonKeys.rev(gameId, day), MonKeys.loc(gameId, day), MonKeys.cat(gameId, day)],
  };
}

/** Project the atomic mon snapshot (cnt+rev+loc+cat + gen) into MONETIZATION_CELL rows. */
function projectMonetizationCell(dataHashes: Record<string, Record<string, string>>, gen: number): FlushRow[] {
  // Identify each sibling by its key suffix (cnt/rev/loc/cat). We do not know the keys
  // here directly, so classify by inspecting field shapes: instead, the flush service
  // hands the hashes keyed by their Redis key — pick them by suffix.
  let cntHash: Record<string, string> = {};
  let revHash: Record<string, string> = {};
  let locHash: Record<string, string> = {};
  let catHash: Record<string, string> = {};
  let gameId = '';
  let day = '';
  for (const [key, hash] of Object.entries(dataHashes)) {
    const p = parseMonBucketKey(key);
    if (!p) {
      continue;
    }
    gameId = p.gameId;
    day = p.day;
    if (p.kind === 'cnt') {
      cntHash = hash;
    } else if (p.kind === 'rev') {
      revHash = hash;
    } else if (p.kind === 'loc') {
      locHash = hash;
    } else if (p.kind === 'cat') {
      catHash = hash;
    }
  }
  if (gameId === '' || day === '') {
    return [];
  }

  const cells = new Map<string, CellAcc>();
  const accFor = (cellKeyStr: string): CellAcc | null => {
    const parsedCell = parseCellKey(cellKeyStr);
    if (!parsedCell) {
      return null;
    }
    let acc = cells.get(cellKeyStr);
    if (!acc) {
      acc = {
        pk: { game_id: gameId, product_id: parsedCell.productId, dim_combo: parsedCell.dimCombo, utc_day: day },
        purchaseCount: '0',
        revenueNormalized: '0',
        productCategory: '',
        localBreakdown: {},
      };
      cells.set(cellKeyStr, acc);
    }
    return acc;
  };

  for (const [cellKeyStr, value] of Object.entries(cntHash)) {
    if (cellKeyStr === SEEDED_MARKER_FIELD) continue;
    const acc = accFor(cellKeyStr);
    if (acc) acc.purchaseCount = value;
  }
  for (const [cellKeyStr, value] of Object.entries(revHash)) {
    if (cellKeyStr === SEEDED_MARKER_FIELD) continue;
    const acc = accFor(cellKeyStr);
    if (acc) acc.revenueNormalized = value;
  }
  for (const [cellKeyStr, value] of Object.entries(catHash)) {
    if (cellKeyStr === SEEDED_MARKER_FIELD) continue;
    const acc = accFor(cellKeyStr);
    if (acc) acc.productCategory = value;
  }
  for (const [field, value] of Object.entries(locHash)) {
    if (field === SEEDED_MARKER_FIELD) continue;
    const parsedLoc = parseLocField(field);
    if (!parsedLoc) continue;
    const acc = accFor(parsedLoc.cellKey);
    if (acc) acc.localBreakdown[parsedLoc.currency] = value;
  }

  return [...cells.values()].map((acc) => ({
    pk: acc.pk,
    values: {
      purchase_count: acc.purchaseCount,
      revenue_normalized: acc.revenueNormalized,
      revenue_local_breakdown: acc.localBreakdown,
      product_category: acc.productCategory,
    },
    guard: gen,
  }));
}

export const MON_CELL_FLUSH_PLAN: ClassNFlushPlan = {
  domain: 'mon',
  spec: MONETIZATION_MERGE_SPECS.monetizationCell,
  relatedKeys: monRelatedKeys,
  projectN: projectMonetizationCell,
};

// ---------------------------------------------------------------------------
// PAYER_DAY.revenue_day_total — class-N atomic-snapshot plan (the `rev` domain).
// The rev day-total hash gen rides the mon meta gen for that day (same INCR).
// ---------------------------------------------------------------------------

function revRelatedKeys(bucketKey: string): { metaKey: string; dataKeys: readonly string[] } | null {
  const parsed = parseRevBucketKey(bucketKey);
  if (!parsed) {
    return null;
  }
  const { gameId, day } = parsed;
  return { metaKey: MonKeys.meta(gameId, day), dataKeys: [RevKeys.day(gameId, day)] };
}

function projectPayerDayRevenue(dataHashes: Record<string, Record<string, string>>, gen: number): FlushRow[] {
  for (const [key, hash] of Object.entries(dataHashes)) {
    const p = parseRevBucketKey(key);
    if (!p) {
      continue;
    }
    const total = hash[REV_TOTAL_FIELD] ?? '0';
    return [
      {
        pk: { game_id: p.gameId, utc_day: p.day },
        values: { revenue_day_total: total },
        guard: gen,
      },
    ];
  }
  return [];
}

export const REV_DAY_FLUSH_PLAN: ClassNFlushPlan = {
  domain: 'rev',
  spec: MONETIZATION_MERGE_SPECS.payerDayRevenue,
  relatedKeys: revRelatedKeys,
  projectN: projectPayerDayRevenue,
};

// ---------------------------------------------------------------------------
// PAYER_DAY.payer_members — class-S set plan (the `payer` domain, plain path).
// ---------------------------------------------------------------------------

/**
 * `payer:{day}` HASH-as-set → one PAYER_DAY.payer_members row. Mirrors 003's `act`
 * projector: the payer bucket is a HASH whose FIELD-NAMES are the payer user_ids (so
 * the shared HGETALL flush path reads it), emitted as a jsonb OBJECT map for the
 * class-S `||` object-union (idempotent — a re-flush of a contained set is a no-op).
 * The read model materializes the member LIST from this object's keys.
 */
function projectPayerMembers(bucketKey: string, hash: Record<string, string>): FlushRow[] {
  const parsed = parsePayerBucketKey(bucketKey);
  if (!parsed) {
    return [];
  }
  const members: Record<string, true> = {};
  for (const userId of Object.keys(hash)) {
    if (userId === SEEDED_MARKER_FIELD) {
      continue;
    }
    members[userId] = true;
  }
  return [{ pk: { game_id: parsed.gameId, utc_day: parsed.day }, values: { payer_members: members } }];
}

/**
 * PAYER_DAY.payer_members plan (class-S). The `payer` bucket is a HASH-as-set (field =
 * user_id) so it rides the shared HGETALL DomainFlushPlan path. Column is `payer_members`
 * (jsonb object-union) — distinct from the rev plan's `revenue_day_total`, so both plans
 * upsert PAYER_DAY without clobbering each other's column.
 */
export const PAYER_MEMBERS_FLUSH_PLAN: DomainFlushPlan = {
  domain: 'payer',
  spec: MONETIZATION_MERGE_SPECS.payerDayMembers,
  project: projectPayerMembers,
};

/** Field-name constants re-exported for the hot hook / read model. */
export { REV_TOTAL_FIELD, REV_LOC_PREFIX };
