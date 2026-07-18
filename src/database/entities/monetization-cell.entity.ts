import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * MONETIZATION_CELL — the segmented-revenue result table ([006-monetization] design
 * ER row 2). Grain: game × product_id × dim_combo × logical-day. Class-N flushed
 * cell (Foundation §3.2.1) — `gen`-gated, GREATEST FORBIDDEN (the enrichment MOVE
 * DECREMENTS a cell's count/revenue; GREATEST would freeze a pre-move higher value
 * and double-count). The gen guard replaces the whole absolute under
 * `WHERE EXCLUDED.gen >= target.gen`.
 *
 * `dim_combo` is the canonical lexicographic `name=value|…` encoding (dim-combo.ts)
 * carrying the first-class `unknown` (not supplied) and `other` (over cardinality
 * budget) literals. `revenue_local_breakdown` (currency → local sum, jsonb) is the
 * UNSEALED re-normalization source — an open day re-normalizes revenue from
 * local × as-of FX without re-ingest.
 *
 * BIGINT → STRING from TypeORM; numeric stays string. snake_case via SnakeNamingStrategy.
 */
@Entity('monetization_cell')
export class MonetizationCellEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  /** The SKU / package sold. */
  @PrimaryColumn({ type: 'text' })
  productId!: string;

  /** Canonical `name=value|…` dimension encoding (unknown/other first-class). */
  @PrimaryColumn({ type: 'text' })
  dimCombo!: string;

  /** Corrected logical day (Foundation §4.7) — DATE. */
  @PrimaryColumn({ type: 'date' })
  utcDay!: string;

  /** Number of distinct server-verified prod purchases in this cell (class-N absolute). */
  @Column({ type: 'bigint', default: 0 })
  purchaseCount!: string;

  /** Σ normalized (converted) revenue for this cell (class-N absolute). */
  @Column({ type: 'numeric', precision: 24, scale: 6, default: 0 })
  revenueNormalized!: string;

  /** Coarse category for read-time marginalization (non-key). */
  @Column({ type: 'text', default: '' })
  productCategory!: string;

  /** currency → running local-amount sum (jsonb) — the unsealed re-normalization source. */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  revenueLocalBreakdown!: Record<string, string>;

  /**
   * Class-N generation gate (Foundation §3.2.1). Monotone per bucket; INCR'd inside
   * every MOVE / FX recompute atomic block. The flush merge accepts a write only
   * WHERE EXCLUDED.gen >= target.gen — a stale (pre-move) snapshot loses.
   */
  @Column({ type: 'smallint', default: 0 })
  gen!: number;
}
