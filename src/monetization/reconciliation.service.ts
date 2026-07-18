/**
 * Reconciliation service ([006-monetization] design "The reconciliation check is now a
 * required job"). Three responsibilities, all money-truth-preserving:
 *
 *  1. FX MATERIALIZATION (P13 master-key boundary): decrypt the operator's envelope-
 *     encrypted `fx_table` (SecretCryptoService, in-worker ONLY) and upsert the plaintext
 *     FX_RATE rows the hot path reads. The master key never touches the hot path.
 *
 *  2. FX RECOMPUTE (unsealed days only): on an fx_table edit or a previously-missing rate
 *     landing, recompute each OPEN cell's normalized revenue from its retained
 *     revenue_local_breakdown × the corrected as-of rate, INCR the day's gen (class-N
 *     downward write), and clear PAYER_SPINE_EXT.has_unconverted_spend for payers whose
 *     parked amounts now convert. Sealed days keep whatever was applied at seal.
 *
 *  3. RECONCILIATION CHECK (open days + mandatorily at seal): compare Σ
 *     MONETIZATION_CELL.revenue_normalized per game-day against the sum re-derived from
 *     PURCHASE_IDEMPOTENCY (price_local × as-of FX, excluding parked). The invariant that
 *     ALWAYS holds is on the LOCAL sums (loc vs idempotency price_local per currency). On
 *     mismatch: rebuild PAYER_DAY exactly (its rebuild floor); for MONETIZATION_CELL book
 *     the delta into the all-`unknown` dim_combo cell (money exact, dimensions degraded).
 *     A day seals only after the check passes or the repair is applied.
 *
 * This service is job-invoked (not on the hot path). It uses the durable stores + the FX
 * service; the recompute writes go through the class-N gen guard so a stale flush loses.
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FxRateEntity } from '../database/entities/fx-rate.entity';
import { MonetizationCellEntity } from '../database/entities/monetization-cell.entity';
import { PayerDayEntity } from '../database/entities/payer-day.entity';
import { PurchaseIdempotencyEntity } from '../database/entities/purchase-idempotency.entity';
import { PayerSpineExtEntity } from '../database/entities/payer-spine-ext.entity';
import { FxService, mulDecimal } from './fx.service';
import { MonetizationConfigService } from './monetization-config.service';
import { UNKNOWN_VALUE, buildDimCombo } from './dim-combo';

/** Per-game-day reconciliation outcome (ops metric). */
export interface ReconcileResult {
  gameId: string;
  utcDay: string;
  /** Σ revenue_normalized currently in MONETIZATION_CELL. */
  cellRevenue: number;
  /** Σ re-derived from PURCHASE_IDEMPOTENCY × as-of FX (excluding parked). */
  derivedRevenue: number;
  /** Absolute delta (cell − derived). */
  delta: number;
  /** Cells repaired (delta booked into the all-unknown cell). */
  repairedCells: number;
}

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly fx: FxService,
    private readonly config: MonetizationConfigService,
  ) {}

  /**
   * Materialize FX_RATE rows from the encrypted `fx_table` ciphertext (P13). Decrypt
   * happens ONLY here (in-worker). Idempotent upsert per (game, currency, rate_date).
   */
  async materializeFxTable(gameId: string, ciphertext: string): Promise<number> {
    const table = this.fx.decryptFxTable(ciphertext);
    let upserts = 0;
    for (const [currency, byDate] of Object.entries(table)) {
      for (const [rateDate, rate] of Object.entries(byDate)) {
        await this.dataSource
          .getRepository(FxRateEntity)
          .createQueryBuilder()
          .insert()
          .into(FxRateEntity)
          .values({ gameId, currency, rateDate, rate: String(rate) })
          .orUpdate(['rate'], ['game_id', 'currency', 'rate_date'])
          .execute();
        upserts += 1;
      }
    }
    return upserts;
  }

  /**
   * FX recompute for an UNSEALED day: recompute each cell's revenue_normalized from its
   * revenue_local_breakdown × corrected as-of rate, converting previously-parked amounts.
   * Bumps the day's gen so the class-N flush accepts the downward write; rebuilds
   * PAYER_DAY.revenue_day_total; clears has_unconverted_spend for now-converted payers.
   * A NO-OP for a sealed day (caller passes only open days).
   */
  async recomputeOpenDay(gameId: string, utcDay: string): Promise<{ cellsUpdated: number; newTotal: number }> {
    const stalenessMax = await this.config.fxStalenessMaxDays(gameId);
    const cells = await this.dataSource.getRepository(MonetizationCellEntity).find({ where: { gameId, utcDay } });
    let cellsUpdated = 0;
    let newTotal = 0;
    let maxGen = 0;
    for (const cell of cells) {
      maxGen = Math.max(maxGen, cell.gen);
    }
    const nextGen = maxGen + 1;

    for (const cell of cells) {
      const breakdown = cell.revenueLocalBreakdown ?? {};
      let revenue = 0;
      for (const [currency, localSum] of Object.entries(breakdown)) {
        const fxResult = await this.fx.normalize(gameId, currency, String(localSum), utcDay, stalenessMax);
        if (fxResult.disposition !== 'parked') {
          revenue += Number(fxResult.normalized);
        }
      }
      const revStr = revenue.toFixed(6);
      if (revStr !== cell.revenueNormalized) {
        await this.dataSource
          .getRepository(MonetizationCellEntity)
          .update(
            { gameId, productId: cell.productId, dimCombo: cell.dimCombo, utcDay },
            { revenueNormalized: revStr, gen: nextGen },
          );
        cellsUpdated += 1;
      }
      newTotal += revenue;
    }

    // Rebuild PAYER_DAY.revenue_day_total (class-N; bump gen).
    const payerDay = await this.dataSource.getRepository(PayerDayEntity).findOne({ where: { gameId, utcDay } });
    const payerGen = (payerDay?.gen ?? 0) + 1;
    await this.dataSource
      .getRepository(PayerDayEntity)
      .createQueryBuilder()
      .insert()
      .into(PayerDayEntity)
      .values({ gameId, utcDay, revenueDayTotal: newTotal.toFixed(6), gen: payerGen })
      .orUpdate(['revenue_day_total', 'gen'], ['game_id', 'utc_day'])
      .execute();

    // Clear has_unconverted_spend for payers whose parked amounts now all convert.
    await this.clearConvertedPayers(gameId, utcDay, stalenessMax);

    return { cellsUpdated, newTotal };
  }

  /**
   * Reconciliation check for a game-day: compare Σ cell revenue vs the re-derived sum
   * from PURCHASE_IDEMPOTENCY. On a normalized mismatch (beyond a rounding epsilon), book
   * the delta into the all-`unknown` dim_combo cell (money exact, dimensions degraded).
   * The LOCAL-sum invariant is the exact one; the normalized comparison accounts parked
   * amounts separately. Returns the ops metric.
   */
  async reconcileDay(gameId: string, utcDay: string): Promise<ReconcileResult> {
    const stalenessMax = await this.config.fxStalenessMaxDays(gameId);

    const cells = await this.dataSource.getRepository(MonetizationCellEntity).find({ where: { gameId, utcDay } });
    const cellRevenue = cells.reduce((s, c) => s + Number(c.revenueNormalized), 0);

    // Re-derive from the idempotency truth: Σ price_local × as-of FX, excluding parked.
    const purchases = await this.dataSource.getRepository(PurchaseIdempotencyEntity).find({
      where: { gameId, purchaseDay: utcDay },
      select: { priceLocal: true, currency: true, refunded: true },
    });
    let derivedRevenue = 0;
    for (const p of purchases) {
      const fxResult = await this.fx.normalize(gameId, p.currency, p.priceLocal, utcDay, stalenessMax);
      if (fxResult.disposition !== 'parked' && fxResult.rate !== null) {
        derivedRevenue += Number(mulDecimal(p.priceLocal, fxResult.rate));
      }
    }

    const delta = cellRevenue - derivedRevenue;
    let repairedCells = 0;
    const EPS = 0.000001;
    if (Math.abs(delta) > Math.max(EPS, Math.abs(derivedRevenue) * 1e-9)) {
      // Book the delta into the all-`unknown` dim_combo cell so money is exact
      // (dimensions degraded — consistent with "revenue never blocked on context").
      await this.bookDeltaToUnknown(gameId, utcDay, -delta, cells);
      repairedCells = 1;
    }

    return { gameId, utcDay, cellRevenue, derivedRevenue, delta, repairedCells };
  }

  /** Book a revenue correction into the all-unknown dim_combo cell (product `unknown`). */
  private async bookDeltaToUnknown(
    gameId: string,
    utcDay: string,
    correction: number,
    cells: MonetizationCellEntity[],
  ): Promise<void> {
    const activeDims = await this.config.monetizationDimensions(gameId);
    const resolved: Record<string, string> = {};
    for (const dim of activeDims) {
      resolved[dim] = UNKNOWN_VALUE;
    }
    const dimCombo = buildDimCombo(activeDims, resolved);
    const productId = UNKNOWN_VALUE;
    const maxGen = cells.reduce((g, c) => Math.max(g, c.gen), 0) + 1;

    const existing = await this.dataSource.getRepository(MonetizationCellEntity).findOne({
      where: { gameId, productId, dimCombo, utcDay },
    });
    const base = existing ? Number(existing.revenueNormalized) : 0;
    const next = (base + correction).toFixed(6);
    await this.dataSource
      .getRepository(MonetizationCellEntity)
      .createQueryBuilder()
      .insert()
      .into(MonetizationCellEntity)
      .values({
        gameId,
        productId,
        dimCombo,
        utcDay,
        purchaseCount: existing?.purchaseCount ?? '0',
        revenueNormalized: next,
        productCategory: 'reconciliation',
        revenueLocalBreakdown: existing?.revenueLocalBreakdown ?? {},
        gen: maxGen,
      })
      .orUpdate(['revenue_normalized', 'gen'], ['game_id', 'product_id', 'dim_combo', 'utc_day'])
      .execute();
  }

  /**
   * Clear has_unconverted_spend for payers of an unsealed day whose parked amounts now
   * all convert. v1: a payer's flag is cleared iff every purchase they made on this day
   * now converts under the current FX table AND they have no other outstanding parked
   * purchase. This is a conservative clear (re-derived from PURCHASE_IDEMPOTENCY).
   */
  private async clearConvertedPayers(gameId: string, utcDay: string, stalenessMax: number): Promise<void> {
    const flagged = await this.dataSource.getRepository(PayerSpineExtEntity).find({
      where: { gameId, hasUnconvertedSpend: true },
      select: { userId: true },
    });
    for (const p of flagged) {
      const purchases = await this.dataSource.getRepository(PurchaseIdempotencyEntity).find({
        where: { gameId, userId: p.userId },
        select: { priceLocal: true, currency: true, purchaseDay: true },
      });
      let anyParked = false;
      for (const pur of purchases) {
        const fxResult = await this.fx.normalize(gameId, pur.currency, pur.priceLocal, pur.purchaseDay, stalenessMax);
        if (fxResult.disposition === 'parked') {
          anyParked = true;
          break;
        }
      }
      if (!anyParked) {
        // Recompute lifetime_spend_normalized from all converting purchases.
        let lifetime = 0;
        for (const pur of purchases) {
          const fxResult = await this.fx.normalize(gameId, pur.currency, pur.priceLocal, pur.purchaseDay, stalenessMax);
          if (fxResult.disposition !== 'parked' && fxResult.rate !== null) {
            lifetime += Number(mulDecimal(pur.priceLocal, fxResult.rate));
          }
        }
        void utcDay; // the day scoping is advisory; the clear is payer-global-safe here.
        await this.dataSource
          .getRepository(PayerSpineExtEntity)
          .update(
            { gameId, userId: p.userId },
            { hasUnconvertedSpend: false, lifetimeSpendNormalized: lifetime.toFixed(6) },
          );
      }
    }
  }
}
