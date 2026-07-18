import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * ECONOMY_SUPPLY_DAY — the snapshot-at-seal money-supply level (Q5, ratified
 * 2026-07-17; [004-economy] design ER row 4). A THIRD durable class beside result
 * cells and spine touches: written ONCE at day-seal (not by the periodic flusher)
 * by reading the durable BALANCE_SNAPSHOT rows at the capture moment. Gated on
 * `economy_depth_capture_mode`.
 *
 *   - `moneySupply`      = Σ `last_known_balance` over every balance-reporting user
 *                          (dormant stockpilers still counted — day-less, never
 *                          pruned). Labelled "over N balance-reporting holders".
 *   - `depthPercentiles` = jsonb { p50, p90, … } of the per-user balances.
 *   - `nUsers`           = balance-reporting holder count (coverage; supply rises
 *                          merely when more users report).
 *   - `trustedSupply`    = optional advisory Σ over rows whose last writer was
 *                          `server` (approximate when a client overwrites a
 *                          server-written balance via LWW).
 *
 * Rebuildable in principle from the raw floor (replay balance_after LWW to any day
 * boundary); days processed while depth was off are unrecoverable (forward-only).
 *
 * BIGINT → STRING from TypeORM. snake_case columns via SnakeNamingStrategy.
 */
@Entity('economy_supply_day')
export class EconomySupplyDayEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  @PrimaryColumn({ type: 'text' })
  currency!: string;

  /** Logical day the supply is snapshotted "as of" (the sealing day). */
  @PrimaryColumn({ type: 'date' })
  utcDay!: string;

  /** Σ last_known_balance over all balance-reporting holders. */
  @Column({ type: 'bigint', default: 0 })
  moneySupply!: string;

  /** { p50, p90, … } percentiles of per-user balances (jsonb). */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  depthPercentiles!: Record<string, number>;

  /** Balance-reporting holder count (coverage denominator). */
  @Column({ type: 'int', default: 0 })
  nUsers!: number;

  /** Optional advisory Σ over server-provenance rows only. */
  @Column({ type: 'bigint', default: 0 })
  trustedSupply!: string;
}
