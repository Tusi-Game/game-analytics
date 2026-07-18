import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * PAYER_SPINE_EXT — the tier-2 payer extension ([007-derived-kpis] design ER row 1,
 * written by 06 on the purchase-accept signal, bridge 05.5). One row per (game_id,
 * user_id), exists IFF the user ever paid (payers ≪ users; non-payers cost zero).
 *
 *   - `first_purchase_day`         write-once logical day of the first-ever verified
 *                                  prod purchase (mirrors the retention set-once bit)
 *                                  → first-purchase conversion.
 *   - `lifetime_spend_normalized`  monotonic Σ over CONVERTED rows (Q3) → payer_tier
 *                                  read pre-purchase against payer_tier_rule fixed
 *                                  thresholds. A parked (fx_unconverted) purchase adds
 *                                  0 and sets has_unconverted_spend.
 *   - `has_unconverted_spend`      the whale-mis-tier abstention: while true the tier
 *                                  reads `indeterminate` (never a deflated `minnow`);
 *                                  cleared when the parked amount converts pre-seal.
 *
 * Durable-immediate, gate-coupled (05's step-6 gate). Payer family keys (game_id,
 * user_id) as a LOGICAL association — NO enforced USER_SPINE FK (Q1). Rebuildable
 * from PURCHASE_IDEMPOTENCY + dated FX.
 *
 * numeric stays STRING; snake_case via SnakeNamingStrategy.
 */
@Entity('payer_spine_ext')
export class PayerSpineExtEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  @PrimaryColumn({ type: 'text' })
  userId!: string;

  /** Write-once logical day of the payer's first-ever verified prod purchase. */
  @Column({ type: 'date' })
  firstPurchaseDay!: string;

  /** Monotonic Σ converted spend (never decremented). The payer-tier source. */
  @Column({ type: 'numeric', precision: 24, scale: 6, default: 0 })
  lifetimeSpendNormalized!: string;

  /** True while any parked (unconverted) spend is outstanding → tier `indeterminate`. */
  @Column({ type: 'boolean', default: false })
  hasUnconvertedSpend!: boolean;
}
