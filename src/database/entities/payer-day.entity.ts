import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * PAYER_DAY — per game × logical-day payer set + day-revenue total ([006-monetization]
 * design ER row 3). MIXED CLASS by field (different fields flush different classes):
 *   - `payer_members`     — the distinct paying user_ids that day → class-S set-union
 *                           (exact v1; HLL is the scale lever). Stored as a jsonb OBJECT
 *                           map (`{ "<user_id>": true }`) so the class-S `||` merges by
 *                           object key-union (an array `||` would CONCAT, not union —
 *                           mirrors ACTIVE_USER_DAY).
 *   - `revenue_day_total` — Σ normalized day revenue → class-N (FX recompute mutates
 *                           it downward on re-normalization), guarded by its OWN `gen`
 *                           column. GREATEST FORBIDDEN.
 *
 * Rebuildable EXACTLY from PURCHASE_IDEMPOTENCY (payer set, day totals are per-txn
 * durable). Feeds 007 KPIs (PayingUsers window-union, Revenue).
 *
 * numeric stays STRING from TypeORM; snake_case via SnakeNamingStrategy.
 */
@Entity('payer_day')
export class PayerDayEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  @PrimaryColumn({ type: 'date' })
  utcDay!: string;

  /** Distinct paying user_ids that day, jsonb OBJECT map (`{ "<user_id>": true }`). */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  payerMembers!: Record<string, true>;

  /** Σ normalized day revenue (class-N absolute; FX recompute mutates it). */
  @Column({ type: 'numeric', precision: 24, scale: 6, default: 0 })
  revenueDayTotal!: string;

  /** Class-N generation gate for `revenue_day_total` (its own gen column). */
  @Column({ type: 'smallint', default: 0 })
  gen!: number;
}
