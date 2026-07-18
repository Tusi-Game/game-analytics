/**
 * Flush merge-rule engine (foundation §3.2.1) — the SQL generator shared by
 * EVERY story's flush. Each flushed structure is assigned exactly one class,
 * fixed for its lifetime; this module turns a class + a column spec into the
 * idempotent `INSERT … ON CONFLICT DO UPDATE` that upserts ABSOLUTE values.
 *
 * CRITICAL invariants (all enforced here, BY CONSTRUCTION):
 *   - Deltas NEVER flush — only absolute cell values. The engine only ever
 *     emits an absolute upsert; there is no additive path.
 *   - Every class is a NO-OP on retry:
 *       M — GREATEST(target, EXCLUDED) of an equal value is a no-op;
 *       N — same-`gen` identical absolute is a no-op; a stale `gen` is rejected;
 *       S — union with an already-contained set is a no-op;
 *       L — equal-`as_of` guard rejects the re-write;
 *       mixed-cat — GREATEST/LEAST/UNION of equal values is a no-op.
 *   - first_seen = LEAST (min) — DARK-SPOT #2. Everything else in cat is
 *     GREATEST/UNION. Getting this backward silently corrupts a never-sealing
 *     structure, so it lives in one clearly-labelled place.
 *
 * The engine emits parametrized SQL (`$1, $2, …`) + an ordered param array so
 * the caller runs it through TypeORM's `query()` with no string interpolation of
 * values. Postgres executes the merge server-side, so a torn Redis read or a
 * retried flush both resolve to the durable-correct value.
 */

import { FlushClass, FlushTaxonomy } from '../../common/redis-keys/flush-class';

/** How a single value column merges on conflict. Mirrors the §3.2.1 table. */
export type ColumnMergeRule =
  | 'greatest' // M / cat.count,last_seen — monotone-up
  | 'least' // cat.first_seen — monotone-down (LOAD-BEARING, DARK-SPOT #2)
  | 'gen-gated' // N — replace WHERE EXCLUDED.gen >= target.gen
  | 'set-union' // S / cat.property_type_sets — target ∪ EXCLUDED
  | 'lww'; // L — replace WHERE EXCLUDED.as_of >= target.as_of

/** One value (non-PK) column and how it merges. */
export interface ColumnSpec {
  /** snake_case column name as it exists in Postgres. */
  column: string;
  /** The per-column merge rule. */
  rule: ColumnMergeRule;
}

/** A flushable structure's full merge descriptor. */
export interface MergeTableSpec {
  /** Target table (snake_case). */
  table: string;
  /** Primary-key columns (the conflict target). */
  pkColumns: string[];
  /** Value columns and their merge rules. */
  valueColumns: ColumnSpec[];
  /**
   * For class N and L: the guard column name (`gen` or `as_of`). The gate
   * `WHERE EXCLUDED.<guard> >= target.<guard>` protects EVERY value column of a
   * gen-gated / LWW structure in one clause.
   */
  guardColumn?: string;
}

/** A ready-to-run parametrized statement. */
export interface FlushStatement {
  /** Parametrized SQL with `$1…$n` placeholders. */
  sql: string;
  /** Ordered parameter values for the placeholders. */
  params: unknown[];
}

/** One absolute row to upsert: PK values + value-column values. */
export interface FlushRow {
  /** PK column → value, in the same order as {@link MergeTableSpec.pkColumns}. */
  pk: Record<string, unknown>;
  /** Value column → absolute value. Set-union columns take a string[] (jsonb). */
  values: Record<string, unknown>;
  /** Guard value (`gen` integer or `as_of` timestamp) — required for N and L. */
  guard?: unknown;
}

function quoteIdent(name: string): string {
  // Column/table names are engine-internal (never user input) but we still
  // validate so a typo can't silently produce malformed SQL.
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`[flush-merge] illegal identifier "${name}" — expected snake_case`);
  }
  return `"${name}"`;
}

/**
 * Build the per-column `SET col = …` fragment for a value column.
 *
 * The LEFT of `=` is the bare column (required by `ON CONFLICT DO UPDATE SET`);
 * every reference to the EXISTING row value on the RIGHT must be TABLE-QUALIFIED
 * (`"tbl"."col"`) — an unqualified name there is ambiguous in Postgres, which
 * errors `42702` (confirmed against real Postgres 16). EXCLUDED refers to the
 * proposed insert row.
 */
function updateFragmentForColumn(table: string, spec: ColumnSpec, guardColumn: string | undefined): string {
  const col = quoteIdent(spec.column);
  const target = `${quoteIdent(table)}.${col}`; // table-qualified existing value
  switch (spec.rule) {
    case 'greatest':
      // Monotone-up (M, cat.count/last_seen). Torn-low read self-heals.
      return `${col} = GREATEST(${target}, EXCLUDED.${col})`;
    case 'least':
      // Monotone-down (cat.first_seen). An earlier first-seen must LOWER it.
      return `${col} = LEAST(${target}, EXCLUDED.${col})`;
    case 'set-union':
      // jsonb/array set union — never blind replace (S, cat.property_type_sets).
      return `${col} = ${jsonbUnionExpr(table, spec.column)}`;
    case 'gen-gated':
    case 'lww':
      // N and L replace with the absolute, guarded by the WHERE clause below.
      if (!guardColumn) {
        throw new Error(`[flush-merge] column "${spec.column}" rule "${spec.rule}" requires a guardColumn`);
      }
      return `${col} = EXCLUDED.${col}`;
    default: {
      const exhaustive: never = spec.rule;
      throw new Error(`[flush-merge] unhandled merge rule ${String(exhaustive)}`);
    }
  }
}

/**
 * jsonb set-union of a `key → string[]` map. `||` (jsonb concat) unions object
 * keys; for a shared key the caller passes the FULL absolute union, so concat of
 * the durable value with the absolute-union stays idempotent (union with a
 * superset = the superset) and retries converge. The existing-value reference is
 * table-qualified (42702 guard).
 */
function jsonbUnionExpr(table: string, column: string): string {
  const col = quoteIdent(column);
  return `${quoteIdent(table)}.${col} || EXCLUDED.${col}`;
}

/**
 * Build the guard `WHERE` clause for gen-gated (N) and LWW (L) structures:
 * `WHERE EXCLUDED.<guard> >= <table>.<guard>`. A stale/retried flush whose guard
 * is older than the durable row is rejected — no clobber, no double-apply.
 * GREATEST is FORBIDDEN for these classes (it would freeze a pre-move higher
 * value); the guard replaces the absolute wholesale under the gate.
 */
function guardWhereClause(spec: MergeTableSpec): string {
  const needsGuard = spec.valueColumns.some((c) => c.rule === 'gen-gated' || c.rule === 'lww');
  if (!needsGuard) {
    return '';
  }
  if (!spec.guardColumn) {
    throw new Error(`[flush-merge] table "${spec.table}" has a gen-gated/lww column but no guardColumn`);
  }
  const g = quoteIdent(spec.guardColumn);
  return ` WHERE EXCLUDED.${g} >= ${quoteIdent(spec.table)}.${g}`;
}

/**
 * Compile a single ABSOLUTE row into a parametrized idempotent upsert for its
 * structure. The same descriptor + an equal row run twice is a no-op under every
 * class (that is the whole point of §3.2.1).
 */
export function buildFlushStatement(spec: MergeTableSpec, row: FlushRow): FlushStatement {
  if (spec.pkColumns.length === 0) {
    throw new Error(`[flush-merge] table "${spec.table}" must declare at least one PK column`);
  }

  // Column list = PK columns + value columns (+ guard column if present).
  const guardCol = spec.guardColumn;
  const insertColumns = [...spec.pkColumns, ...spec.valueColumns.map((c) => c.column)];
  if (guardCol) {
    insertColumns.push(guardCol);
  }

  const params: unknown[] = [];
  const placeholders: string[] = [];
  for (const pkCol of spec.pkColumns) {
    params.push(row.pk[pkCol]);
    placeholders.push(`$${params.length}`);
  }
  for (const vc of spec.valueColumns) {
    const raw = row.values[vc.column];
    // Set-union columns are jsonb — serialise the deduped array/object.
    params.push(vc.rule === 'set-union' ? JSON.stringify(raw) : raw);
    placeholders.push(`$${params.length}`);
  }
  if (guardCol) {
    params.push(row.guard);
    placeholders.push(`$${params.length}`);
  }

  const columnsSql = insertColumns.map(quoteIdent).join(', ');
  const conflictSql = spec.pkColumns.map(quoteIdent).join(', ');

  // The SET list also advances the guard column itself (so a winning write moves
  // the durable gen/as_of forward), gated by the same WHERE clause.
  const setFragments = spec.valueColumns.map((c) => updateFragmentForColumn(spec.table, c, guardCol));
  if (guardCol) {
    setFragments.push(`${quoteIdent(guardCol)} = EXCLUDED.${quoteIdent(guardCol)}`);
  }

  const sql =
    `INSERT INTO ${quoteIdent(spec.table)} (${columnsSql}) VALUES (${placeholders.join(', ')}) ` +
    `ON CONFLICT (${conflictSql}) DO UPDATE SET ${setFragments.join(', ')}` +
    guardWhereClause(spec) +
    ';';

  return { sql, params };
}

/**
 * The fixed merge descriptors for 002's own flushed structures. 002 exercises
 * only class M (`event_day_count`, `exception_tally`) and the mixed `cat` rule
 * (`event_catalog`). The other classes' engine paths exist for downstream
 * stories but are not wired to a 002 table.
 */
export const INGEST_MERGE_SPECS = {
  /** EVENT_DAY_COUNT.count — class M (monotone-up). */
  eventDayCount: {
    table: 'event_day_count',
    pkColumns: ['game_id', 'event_name', 'utc_day'],
    valueColumns: [{ column: 'count', rule: 'greatest' }],
  } satisfies MergeTableSpec,

  /** EXCEPTION_TALLY.count — class M (monotone-up). */
  exceptionTally: {
    table: 'exception_tally',
    pkColumns: ['game_id', 'utc_day', 'reason'],
    valueColumns: [{ column: 'count', rule: 'greatest' }],
  } satisfies MergeTableSpec,

  /**
   * EVENT_CATALOG — mixed per-field (DARK-SPOT #2):
   *   count / last_seen → GREATEST, first_seen → LEAST, property_type_sets → UNION.
   * kind/status are set on first insert and never merged down here.
   */
  eventCatalog: {
    table: 'event_catalog',
    pkColumns: ['game_id', 'event_name'],
    valueColumns: [
      { column: 'lifetime_count', rule: 'greatest' },
      { column: 'last_seen', rule: 'greatest' },
      { column: 'first_seen', rule: 'least' }, // ← LEAST. Not GREATEST. (#2)
      // kind/status are set-once metadata (a name has one resolved kind). They are
      // NOT NULL on the entity so they MUST be part of the insert; on conflict we
      // keep the existing (GREATEST on text is a deterministic idempotent no-op).
      { column: 'kind', rule: 'greatest' },
      { column: 'status', rule: 'greatest' },
      // property_type_sets stays LAST — the jsonb union column (a downstream test
      // and the driver both key off it being the final value param).
      { column: 'property_type_sets', rule: 'set-union' },
    ],
  } satisfies MergeTableSpec,
} as const;

/**
 * Assert a taxonomy tag maps to a concrete merge capability the engine can emit.
 * The class-assignment gate (T-00.52): a flushed structure must state its class
 * and that class must be one the engine handles.
 */
export function assertSupportedTaxonomy(taxonomy: FlushTaxonomy): void {
  const supported: ReadonlyArray<FlushClass | 'mixed-cat'> = ['M', 'N', 'S', 'L', 'mixed-cat'];
  if (!supported.includes(taxonomy)) {
    throw new Error(`[flush-merge] unsupported flush taxonomy "${String(taxonomy)}"`);
  }
}
