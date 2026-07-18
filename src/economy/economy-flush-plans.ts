/**
 * Flush plans + merge specs for the `eco` / `bal` domains (T-03.26/27, Foundation
 * §3.2/§3.2.1). Each plan projects a drained Redis bucket's absolute hash into
 * {@link FlushRow}s the shared {@link buildFlushStatement} engine upserts
 * idempotently under the per-class merge rule.
 *
 *   eco (class M) → ECONOMY_FLOW_RESULT + ECONOMY_FLOW_SEGMENT_RESULT
 *                   (amount_sum + event_count both GREATEST; base vs :seg picked
 *                    by the bucket-key shape — the `eco` domain holds both, and
 *                    each plan skips the shape it does not own, exactly as 002's
 *                    cnt/exc share the `cnt` domain).
 *   bal (class L) → BALANCE_SNAPSHOT
 *                   (as_of-guarded upsert-latest; GREATEST FORBIDDEN — a balance
 *                    legitimately falls. The class-L merge already emits
 *                    `WHERE EXCLUDED.as_of >= balance_snapshot.as_of`.)
 *
 * Every merge is a no-op on retry by construction (class M GREATEST of an equal
 * value; class L equal-as_of guard rejects the re-write). Deltas NEVER flush —
 * only current absolutes.
 */

import type { DomainFlushPlan, FlushRow, MergeTableSpec } from '../workers/flush/flush.service';
import { SEEDED_MARKER_FIELD } from '../common/redis-keys/rehydrate';
import {
  MEASURE_AMOUNT,
  MEASURE_COUNT,
  decodeBalanceEntry,
  parseEcoBucketKey,
  parseEcoField,
  parseEcoSegField,
} from './eco-keys';

// ---------------------------------------------------------------------------
// Merge specs (fixed per structure, Foundation §3.2.1).
// ---------------------------------------------------------------------------

export const ECONOMY_MERGE_SPECS = {
  /** ECONOMY_FLOW_RESULT — class M (amount_sum + event_count both GREATEST). */
  economyFlowResult: {
    table: 'economy_flow_result',
    pkColumns: ['game_id', 'currency', 'utc_day', 'provenance', 'reason', 'flow_type'],
    valueColumns: [
      { column: 'amount_sum', rule: 'greatest' },
      { column: 'event_count', rule: 'greatest' },
    ],
  } satisfies MergeTableSpec,

  /** ECONOMY_FLOW_SEGMENT_RESULT — class M (amount_sum + event_count GREATEST). */
  economyFlowSegmentResult: {
    table: 'economy_flow_segment_result',
    pkColumns: ['game_id', 'currency', 'utc_day', 'provenance', 'segment_dim', 'segment_value', 'reason', 'flow_type'],
    valueColumns: [
      { column: 'amount_sum', rule: 'greatest' },
      { column: 'event_count', rule: 'greatest' },
    ],
  } satisfies MergeTableSpec,

  /**
   * BALANCE_SNAPSHOT — class L. `as_of` is the guard column: the engine emits
   * `SET last_known_balance = EXCLUDED..., provenance = EXCLUDED..., as_of =
   * EXCLUDED.as_of WHERE EXCLUDED.as_of >= balance_snapshot.as_of`. GREATEST is
   * FORBIDDEN here — a balance falls; the LWW guard is the whole mechanism.
   */
  balanceSnapshot: {
    table: 'balance_snapshot',
    pkColumns: ['game_id', 'user_id', 'currency'],
    valueColumns: [
      { column: 'last_known_balance', rule: 'lww' },
      { column: 'provenance', rule: 'lww' },
    ],
    guardColumn: 'as_of',
  } satisfies MergeTableSpec,
} as const;

// ---------------------------------------------------------------------------
// Projectors.
// ---------------------------------------------------------------------------

/** Accumulator pairing amount + count per cell as the hash is scanned. */
interface CellAcc {
  pk: Record<string, unknown>;
  amountSum: string;
  eventCount: string;
}

/**
 * `eco` BASE hash → ECONOMY_FLOW_RESULT rows. Only the `{game}:eco:{day}` shape is
 * projected here; a drained `:seg` key is skipped (the segment plan owns it). Each
 * cell contributes an `a␟…` amount field and an `n␟…` count field which are paired.
 */
function projectEcoBase(bucketKey: string, hash: Record<string, string>): FlushRow[] {
  const parsed = parseEcoBucketKey(bucketKey);
  if (!parsed || parsed.seg) {
    return [];
  }
  const cells = new Map<string, CellAcc>();
  for (const [field, value] of Object.entries(hash)) {
    if (field === SEEDED_MARKER_FIELD) {
      continue;
    }
    const cell = parseEcoField(field);
    if (!cell) {
      continue;
    }
    const cellKey = [cell.provenance, cell.flowType, cell.currency, cell.reason].join('\x1f');
    const acc = cells.get(cellKey) ?? {
      pk: {
        game_id: parsed.gameId,
        currency: cell.currency,
        utc_day: parsed.day,
        provenance: cell.provenance,
        reason: cell.reason,
        flow_type: cell.flowType,
      },
      amountSum: '0',
      eventCount: '0',
    };
    if (cell.measure === MEASURE_AMOUNT) {
      acc.amountSum = value;
    } else if (cell.measure === MEASURE_COUNT) {
      acc.eventCount = value;
    }
    cells.set(cellKey, acc);
  }
  return [...cells.values()].map((acc) => ({
    pk: acc.pk,
    values: { amount_sum: acc.amountSum, event_count: acc.eventCount },
  }));
}

/** `eco` :seg hash → ECONOMY_FLOW_SEGMENT_RESULT rows. Skips the base shape. */
function projectEcoSegment(bucketKey: string, hash: Record<string, string>): FlushRow[] {
  const parsed = parseEcoBucketKey(bucketKey);
  if (!parsed || !parsed.seg) {
    return [];
  }
  const cells = new Map<string, CellAcc>();
  for (const [field, value] of Object.entries(hash)) {
    if (field === SEEDED_MARKER_FIELD) {
      continue;
    }
    const cell = parseEcoSegField(field);
    if (!cell) {
      continue;
    }
    const cellKey = [
      cell.provenance,
      cell.flowType,
      cell.currency,
      cell.segmentDim,
      cell.segmentValue,
      cell.reason,
    ].join('\x1f');
    const acc = cells.get(cellKey) ?? {
      pk: {
        game_id: parsed.gameId,
        currency: cell.currency,
        utc_day: parsed.day,
        provenance: cell.provenance,
        segment_dim: cell.segmentDim,
        segment_value: cell.segmentValue,
        reason: cell.reason,
        flow_type: cell.flowType,
      },
      amountSum: '0',
      eventCount: '0',
    };
    if (cell.measure === MEASURE_AMOUNT) {
      acc.amountSum = value;
    } else if (cell.measure === MEASURE_COUNT) {
      acc.eventCount = value;
    }
    cells.set(cellKey, acc);
  }
  return [...cells.values()].map((acc) => ({
    pk: acc.pk,
    values: { amount_sum: acc.amountSum, event_count: acc.eventCount },
  }));
}

/**
 * `bal:{currency}` hash → BALANCE_SNAPSHOT rows (one per user_id field), class L.
 * The bucket key is `{game}:bal:{currency}`; each field is a user_id whose value
 * decodes to (balance, as_of, provenance, …tie-break). `guard` = as_of (the LWW
 * gate column). A stale as_of is rejected by the merge's WHERE clause; a retried
 * flush writes identical absolutes ⇒ no-op.
 */
function projectBal(bucketKey: string, hash: Record<string, string>): FlushRow[] {
  const parts = bucketKey.split(':');
  if (parts.length < 3 || parts[1] !== 'bal') {
    return [];
  }
  const gameId = parts[0]!;
  // currency is the day-less qualifier (`:`-free by the cap gate) — join any
  // remaining segments defensively (there are none in practice).
  const currency = parts.slice(2).join(':');
  const rows: FlushRow[] = [];
  for (const [userId, value] of Object.entries(hash)) {
    if (userId === SEEDED_MARKER_FIELD) {
      continue;
    }
    const entry = decodeBalanceEntry(value);
    if (!entry) {
      continue;
    }
    rows.push({
      pk: { game_id: gameId, user_id: userId, currency },
      values: { last_known_balance: entry.balance, provenance: entry.provenance },
      guard: new Date(entry.asOfMs).toISOString(),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Plans (registered with FlushJobService via EXTRA_DOMAIN_FLUSH_PLANS).
// The `eco` domain holds BOTH base + :seg bucket keys; it drains ONCE and both
// plans run over that batch, each skipping the shape it does not own (mirrors
// 002's cnt/exc split on one domain).
// ---------------------------------------------------------------------------

export const ECO_BASE_FLUSH_PLAN: DomainFlushPlan = {
  domain: 'eco',
  spec: ECONOMY_MERGE_SPECS.economyFlowResult,
  project: projectEcoBase,
};

export const ECO_SEGMENT_FLUSH_PLAN: DomainFlushPlan = {
  domain: 'eco',
  spec: ECONOMY_MERGE_SPECS.economyFlowSegmentResult,
  project: projectEcoSegment,
};

export const BAL_FLUSH_PLAN: DomainFlushPlan = {
  domain: 'bal',
  spec: ECONOMY_MERGE_SPECS.balanceSnapshot,
  project: projectBal,
};
