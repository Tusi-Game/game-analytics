import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * PAYER_PERIOD_SPEND — per game × period × paying user cumulative spend
 * ([007-derived-kpis] design ER row 2). `period` = UTC calendar month `YYYY-MM`
 * (v1-locked). One row per payer × month with ≥ 1 purchase — payer-bounded
 * (thousands/period at indie scale, never user-bounded). The whale distribution:
 * ranked desc + top-X%-summed at read time.
 *
 * Durable-immediate, gate-coupled (05's step-6 gate, same atomic unit as the
 * PURCHASE_IDEMPOTENCY insert). Formally tier-2 spine; in kind a rebuildable
 * PROJECTION of PURCHASE_IDEMPOTENCY (+ dated FX), exactly as PAYER_DAY is. The
 * cumulative add is made exactly-once by the upstream transaction_id gate.
 *
 * numeric stays STRING; snake_case via SnakeNamingStrategy.
 */
@Entity('payer_period_spend')
export class PayerPeriodSpendEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  /** UTC calendar month `YYYY-MM` (v1). */
  @PrimaryColumn({ type: 'text' })
  period!: string;

  @PrimaryColumn({ type: 'text' })
  userId!: string;

  /** Cumulative normalized verified-prod spend for this payer in this period. */
  @Column({ type: 'numeric', precision: 24, scale: 6, default: 0 })
  spendNormalized!: string;
}
