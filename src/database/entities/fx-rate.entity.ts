import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * FX_RATE — the durable, dated per-currency exchange rate (R9 manager decision). Grain
 * game × currency × rate_date. The as-of lookup (Q8, design step 8) picks the most
 * recent row with `rate_date ≤ purchase_day`, valid iff
 * `purchase_day − rate_date ≤ fx_staleness_max_days`.
 *
 * This table is DERIVED from the operator's `fx_table` CONFIG material — which is a
 * REVERSIBLE infra secret, envelope-encrypted in GAME.config via SecretCryptoService
 * (P13, master key OUTSIDE Postgres). The reconciliation job decrypts fx_table
 * in-worker and materializes/refreshes these rows; the hot path reads only this
 * plaintext dated table (never the ciphertext) so the master key is never on the
 * per-event path.
 *
 * `rate` normalizes local → the platform normalization currency:
 *   normalized = price_local × rate. numeric stays STRING; snake_case via SnakeNamingStrategy.
 */
@Entity('fx_rate')
export class FxRateEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  /** ISO currency the rate converts FROM (into the normalization currency). */
  @PrimaryColumn({ type: 'text' })
  currency!: string;

  /** The date this rate is effective as-of (DATE). */
  @PrimaryColumn({ type: 'date' })
  rateDate!: string;

  /** Multiplier: normalized = price_local × rate. */
  @Column({ type: 'numeric', precision: 24, scale: 10, default: 0 })
  rate!: string;
}
