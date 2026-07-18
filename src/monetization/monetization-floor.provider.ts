/**
 * Per-domain durable FLOOR provider for the monetization hot path (rehydrate-on-miss,
 * Foundation §2.3). The seam's floor-extension pattern (default-hooks.ts): the story
 * INJECTS ITS OWN floor provider scoped to its domains (mon:{cnt,rev,loc,meta,cat},
 * payer, rev) and calls it directly inside the hot hook — NEVER the generic
 * FloorProvider (collision-free by construction).
 *
 * Class-N rehydrate is MANDATORY for FX recompute + absolute flush to be safe
 * post-crash: cnt/rev/loc seed from MONETIZATION_CELL (incl. revenue_local_breakdown),
 * meta.gen seeds from the durable row's max gen, payer/rev seed from PAYER_DAY. A
 * missing durable row → empty floor; the first hot increment establishes the value.
 *
 * numeric/bigint come back from TypeORM as STRINGS; kept as strings end-to-end.
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { DurableFloor } from '../common/redis-keys/rehydrate';
import { MonetizationCellEntity } from '../database/entities/monetization-cell.entity';
import { PayerDayEntity } from '../database/entities/payer-day.entity';
import { cellKey, locField, META_GEN_FIELD, REV_TOTAL_FIELD, revLocField } from './mon-keys';

@Injectable()
export class MonetizationFloorProvider {
  constructor(private readonly dataSource: DataSource) {}

  /** Floor for `mon:{day}:cnt` — durable purchase_count per cell. */
  async cntFloor(gameId: string, utcDay: string): Promise<DurableFloor> {
    const rows = await this.cellsForDay(gameId, utcDay);
    const fields: Record<string, string> = {};
    for (const r of rows) {
      fields[cellKey(r.productId, r.dimCombo)] = r.purchaseCount;
    }
    return { fields };
  }

  /** Floor for `mon:{day}:rev` — durable revenue_normalized per cell. */
  async revFloor(gameId: string, utcDay: string): Promise<DurableFloor> {
    const rows = await this.cellsForDay(gameId, utcDay);
    const fields: Record<string, string> = {};
    for (const r of rows) {
      fields[cellKey(r.productId, r.dimCombo)] = r.revenueNormalized;
    }
    return { fields };
  }

  /** Floor for `mon:{day}:loc` — durable per-currency local sums per cell (from jsonb). */
  async locFloor(gameId: string, utcDay: string): Promise<DurableFloor> {
    const rows = await this.cellsForDay(gameId, utcDay);
    const fields: Record<string, string> = {};
    for (const r of rows) {
      const cell = cellKey(r.productId, r.dimCombo);
      const breakdown = r.revenueLocalBreakdown ?? {};
      for (const [currency, sum] of Object.entries(breakdown)) {
        fields[locField(cell, currency)] = String(sum);
      }
    }
    return { fields };
  }

  /** Floor for `mon:{day}:cat` — durable product_category per cell. */
  async catFloor(gameId: string, utcDay: string): Promise<DurableFloor> {
    const rows = await this.cellsForDay(gameId, utcDay);
    const fields: Record<string, string> = {};
    for (const r of rows) {
      fields[cellKey(r.productId, r.dimCombo)] = r.productCategory ?? '';
    }
    return { fields };
  }

  /**
   * Floor for `mon:{day}:meta` — the `gen` generation gate, seeded from the MAX durable
   * cell gen for the day (so the Redis gen never rewinds below the durable floor). A day
   * with no durable cells seeds gen 0.
   */
  async metaFloor(gameId: string, utcDay: string): Promise<DurableFloor> {
    const rows = await this.cellsForDay(gameId, utcDay);
    let maxGen = 0;
    for (const r of rows) {
      if (r.gen > maxGen) {
        maxGen = r.gen;
      }
    }
    return { fields: { [META_GEN_FIELD]: String(maxGen) } };
  }

  /**
   * Floor for `payer:{day}` — the durable payer member set. Realized as a Redis
   * HASH-as-set (field = user_id, value = "1"), mirroring 003's `act` bucket, so it
   * reuses the standard hash rehydrate + seeded-marker + HGETALL flush machinery (a raw
   * Redis SET cannot carry the hash seeded marker on the same key — WRONGTYPE).
   */
  async payerFloor(gameId: string, utcDay: string): Promise<DurableFloor> {
    const row = await this.dataSource.getRepository(PayerDayEntity).findOne({
      where: { gameId, utcDay },
      select: { payerMembers: true },
    });
    const fields: Record<string, string> = {};
    for (const member of Object.keys(row?.payerMembers ?? {})) {
      fields[member] = '1';
    }
    return { fields };
  }

  /**
   * Floor for `rev:{day}` — durable day total + per-currency day local sums. The `total`
   * field seeds from PAYER_DAY.revenue_day_total; per-currency `loc:{currency}` sums seed
   * from Σ over MONETIZATION_CELL.revenue_local_breakdown for the day (the durable
   * cross-check source for the FX recompute).
   */
  async revDayFloor(gameId: string, utcDay: string): Promise<DurableFloor> {
    const payerRow = await this.dataSource.getRepository(PayerDayEntity).findOne({
      where: { gameId, utcDay },
      select: { revenueDayTotal: true },
    });
    const cells = await this.cellsForDay(gameId, utcDay);
    const locSums = new Map<string, number>();
    for (const c of cells) {
      const breakdown = c.revenueLocalBreakdown ?? {};
      for (const [currency, sum] of Object.entries(breakdown)) {
        locSums.set(currency, (locSums.get(currency) ?? 0) + Number(sum));
      }
    }
    const fields: Record<string, string> = { [REV_TOTAL_FIELD]: payerRow?.revenueDayTotal ?? '0' };
    for (const [currency, sum] of locSums) {
      fields[revLocField(currency)] = String(sum);
    }
    return { fields };
  }

  /** Load the durable cells for a game×day once (shared by the cell floors). */
  private async cellsForDay(gameId: string, utcDay: string): Promise<MonetizationCellEntity[]> {
    return this.dataSource.getRepository(MonetizationCellEntity).find({
      where: { gameId, utcDay },
      select: {
        productId: true,
        dimCombo: true,
        purchaseCount: true,
        revenueNormalized: true,
        revenueLocalBreakdown: true,
        productCategory: true,
        gen: true,
      },
    });
  }
}
