/**
 * ECONOMY_SUPPLY_DAY snapshot-at-seal writer (Q5, T-03.29). At day-seal, gated on
 * `economy_depth_capture_mode`, read the DURABLE BALANCE_SNAPSHOT rows (post-flush)
 * at the capture moment → one WRITE-ONCE row per game×currency×day carrying:
 *   - money_supply     = Σ last_known_balance over ALL balance-reporting holders
 *                        (dormant stockpilers still counted — day-less, never
 *                        pruned; the correct stock-over-all-known-holders defn);
 *   - depth_percentiles= { p50, p90 } over the per-user balances;
 *   - n_users          = balance-reporting holder count (coverage denominator);
 *   - trusted_supply   = advisory Σ over rows whose last writer was `server`.
 *
 * NO hot key, NO open-day bucket — a direct read of the durable snapshot rows. The
 * seal-time job (NOT the periodic flusher) drives this after the day's final flush.
 * `utc_day` is the SEALING day (the day this supply is "as of").
 *
 * The write is idempotent per (game, currency, day): a re-run overwrites with the
 * same absolutes (write-once semantics — a sealed day's balances no longer change
 * for that snapshot boundary in the common case; a manual re-seal recomputes).
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EconomyConfigService } from './economy-config.service';

/** One (currency) supply snapshot outcome (observability / tests). */
export interface SupplySnapshotRow {
  currency: string;
  moneySupply: string;
  nUsers: number;
  depthPercentiles: Record<string, number>;
  trustedSupply: string;
}

@Injectable()
export class EconomySupplySnapshotService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly economyConfig: EconomyConfigService,
  ) {}

  /**
   * Snapshot the money-supply level for every currency of a game "as of" the
   * sealing `utcDay`, from the durable BALANCE_SNAPSHOT rows. No-op (returns [])
   * when depth capture is OFF for the game (forward-only: days processed while off
   * are unrecoverable). Writes one ECONOMY_SUPPLY_DAY row per currency.
   */
  async snapshotDay(gameId: string, utcDay: string): Promise<SupplySnapshotRow[]> {
    if (!(await this.economyConfig.depthCaptureOn(gameId))) {
      return [];
    }

    // Pull every balance-reporting holder's last-known balance, per currency. This
    // is a per-currency scan (indie-scale fine; a bucketed histogram is the named
    // scale lever). Ordered by balance so percentiles are a positional pick.
    const rows: Array<{ currency: string; last_known_balance: string; provenance: string }> =
      await this.dataSource.query(
        `SELECT currency, last_known_balance::text AS last_known_balance, provenance
           FROM balance_snapshot
          WHERE game_id = $1`,
        [gameId],
      );

    // Group by currency; balances are sorted NUMERICALLY in JS below (a SQL
    // `ORDER BY last_known_balance` sorts the ::text alias lexically — wrong).
    const byCurrency = new Map<string, { balances: number[]; supply: bigint; trusted: bigint }>();
    for (const r of rows) {
      const bal = BigInt(r.last_known_balance);
      const g = byCurrency.get(r.currency) ?? { balances: [], supply: 0n, trusted: 0n };
      g.balances.push(Number(r.last_known_balance));
      g.supply += bal;
      if (r.provenance === 'server') {
        g.trusted += bal;
      }
      byCurrency.set(r.currency, g);
    }

    const out: SupplySnapshotRow[] = [];
    for (const [currency, g] of byCurrency) {
      g.balances.sort((a, b) => a - b);
      const percentiles = {
        p50: percentile(g.balances, 0.5),
        p90: percentile(g.balances, 0.9),
      };
      const row: SupplySnapshotRow = {
        currency,
        moneySupply: g.supply.toString(),
        nUsers: g.balances.length,
        depthPercentiles: percentiles,
        trustedSupply: g.trusted.toString(),
      };
      await this.upsertSupplyRow(gameId, currency, utcDay, row);
      out.push(row);
    }
    return out;
  }

  /** Write-once upsert of one ECONOMY_SUPPLY_DAY row (idempotent absolute). */
  private async upsertSupplyRow(
    gameId: string,
    currency: string,
    utcDay: string,
    row: SupplySnapshotRow,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO economy_supply_day
         (game_id, currency, utc_day, money_supply, depth_percentiles, n_users, trusted_supply)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (game_id, currency, utc_day) DO UPDATE SET
         money_supply = EXCLUDED.money_supply,
         depth_percentiles = EXCLUDED.depth_percentiles,
         n_users = EXCLUDED.n_users,
         trusted_supply = EXCLUDED.trusted_supply`,
      [gameId, currency, utcDay, row.moneySupply, JSON.stringify(row.depthPercentiles), row.nUsers, row.trustedSupply],
    );
  }
}

/**
 * Percentile of an ASCENDING-sorted numeric array (nearest-rank / lower). Returns
 * 0 for an empty array. `p` ∈ [0,1]. Used for p50/p90 depth — a positional pick
 * over the per-user balances (indie-scale exact; histogram is the scale lever).
 */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) {
    return 0;
  }
  if (sortedAsc.length === 1) {
    return sortedAsc[0]!;
  }
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx]!;
}
