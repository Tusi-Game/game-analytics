/**
 * Flush-class taxonomy (foundation §3.2.1) — SHARED TYPE STUBS.
 *
 * Every flushed Redis→Postgres structure is assigned exactly one class, fixed
 * for its lifetime. A story never re-chooses its class. This module declares the
 * class LABELS and the merge-rule interface; Unit 2 (the flush engine) fills in
 * the implementations. 002 itself exercises only class M plus the mixed-`cat`
 * per-field rule.
 *
 *  - M  monotonic-additive     → SET value = GREATEST(target, incoming); HSETNX seed
 *  - N  non-monotonic/mutable  → generation-gated absolute (Lua EVAL + gen guard)
 *  - S  set-membership         → SADD union (never blind replace)
 *  - L  LWW-guarded            → SET … WHERE incoming.as_of ≥ target.as_of
 */
export type FlushClass = 'M' | 'N' | 'S' | 'L';

/**
 * The mixed-field structure that fits no single class label: `EVENT_CATALOG`
 * (the `cat` domain). Day-less; merges per FIELD, not per structure:
 *   count / last_seen → GREATEST (max)
 *   first_seen        → LEAST  (min)   ← load-bearing, easy to reverse (OF-2)
 *   property_type_sets→ UNION
 * Kept as a distinct marker so Unit 2 wires the per-field rule, not a class.
 */
export type MixedCatalogFlush = 'mixed-cat';

/** Any flushable structure's merge taxonomy tag. */
export type FlushTaxonomy = FlushClass | MixedCatalogFlush;

/**
 * Describes one flushed structure's merge behaviour. Unit 2 provides the engine
 * that reads this descriptor and emits the correct `ON CONFLICT … DO UPDATE`.
 * Declared here so the descriptor shape is frozen before the engine exists.
 */
export interface FlushClassSpec {
  /** The structure's taxonomy tag. */
  taxonomy: FlushTaxonomy;
  /** Human note on why this class (for the design/lint guard T-00.46). */
  rationale?: string;
}

/** 002's own structures and their fixed classes (the only ones 002 exercises). */
export const INGEST_FLUSH_CLASSES = {
  /** EVENT_DAY_COUNT.count */
  eventDayCount: { taxonomy: 'M', rationale: 'per-day count only rises in-day' } satisfies FlushClassSpec,
  /** EXCEPTION_TALLY.count */
  exceptionTally: { taxonomy: 'M', rationale: 'per-day tally only rises in-day' } satisfies FlushClassSpec,
  /** EVENT_CATALOG — mixed per-field merge (count/last_seen max, first_seen min, types union) */
  eventCatalog: {
    taxonomy: 'mixed-cat',
    rationale: 'day-less; first_seen=LEAST, rest GREATEST/union',
  } satisfies FlushClassSpec,
} as const;
