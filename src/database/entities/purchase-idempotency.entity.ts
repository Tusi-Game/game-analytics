import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * PURCHASE_IDEMPOTENCY — the durable money-dedup UNIQUE key table ([006-monetization]
 * design ER row 1, Foundation §1.3 idempotency-key tier). NOT a spine, NOT a result:
 * "uniqueness keys, not an event log" (permitted alongside the user spine). One row
 * per accepted, eligible purchase; `transaction_id` is the Postgres UNIQUE key that
 * makes money dedup DURABLE and NEVER-windowed — an offline retry arriving DAYS late
 * conflicts and is dropped.
 *
 * Written durable-immediate at step 6b via `INSERT … ON CONFLICT DO NOTHING`; the
 * REAL PurchaseDedupGate (dedup-gate.service.ts) claims the row. It is also the
 * rebuild floor for PAYER_DAY, PAYER_PERIOD_SPEND, PAYER_SPINE_EXT and the
 * reconciliation check (Σ price_local per currency vs the `loc` breakdown).
 *
 * Payer family is a LOGICAL association keyed (game_id, user_id) — NO enforced
 * USER_SPINE FK (a never-sessioned payer commits normally; Q1). BIGINT → STRING from
 * TypeORM; snake_case columns via SnakeNamingStrategy.
 */
@Entity('purchase_idempotency')
export class PurchaseIdempotencyEntity {
  /** Store-issued unique id (Apple Transaction.id / Google order id). The UNIQUE dedup key. */
  @PrimaryColumn({ type: 'text' })
  transactionId!: string;

  /** Store-issued stable id across renewal/restore (carried; consumers read it here). */
  @Column({ type: 'text' })
  originalTransactionId!: string;

  /** Game scope (text FK to GAME, never bigint). */
  @Column({ type: 'text' })
  gameId!: string;

  /** Game user_id passed to the server SDK at validation (identity↔store mapping). */
  @Column({ type: 'text' })
  userId!: string;

  /** Corrected logical day (Foundation §4.7) of the purchase — DATE, no time-of-day. */
  @Column({ type: 'date' })
  purchaseDay!: string;

  /** Raw local charged amount, stored SEPARATELY from any normalized value. */
  @Column({ type: 'numeric', precision: 20, scale: 6, default: 0 })
  priceLocal!: string;

  /** ISO currency of `price_local`. */
  @Column({ type: 'text' })
  currency!: string;

  /** SKU / package sold (story-added; audit + day-total re-derivation). */
  @Column({ type: 'text' })
  productId!: string;

  /** Gross-only v1 flag; default false. The v2 net-revenue hook. */
  @Column({ type: 'boolean', default: false })
  refunded!: boolean;
}
