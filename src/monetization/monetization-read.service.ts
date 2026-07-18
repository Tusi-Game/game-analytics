/**
 * Monetization + derived-KPI read model ([006-monetization] design "Dashboard read-model",
 * [007-derived-kpis] design "API / contract surface"). ALL read-time — no KPI value is
 * stored (Foundation §3.3). Live-vs-flushed: sealed days from Postgres; the open day
 * merges the live Redis mon/payer/rev buckets with the durable floor.
 *
 * DIVISION-BY-ZERO → N/A never 0 (§2). Every money numerator is server-sourced verified
 * prod only; every active denominator is client-session-sourced (§3 trust boundary).
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { SEEDED_MARKER_FIELD } from '../common/redis-keys/rehydrate';
import { MonetizationCellEntity } from '../database/entities/monetization-cell.entity';
import { PayerDayEntity } from '../database/entities/payer-day.entity';
import { PayerPeriodSpendEntity } from '../database/entities/payer-period-spend.entity';
import { PayerSpineExtEntity } from '../database/entities/payer-spine-ext.entity';
import { ActiveUserDayEntity } from '../database/entities/active-user-day.entity';
import { UserSpineEntity } from '../database/entities/user-spine.entity';
import { MonetizationConfigService, WAU_WINDOW_DAYS, periodOfDay } from './monetization-config.service';
import { PayerKeys, RevKeys, REV_TOTAL_FIELD, parseCellKey } from './mon-keys';
import { dimComboHas, parseDimCombo } from './dim-combo';

/** A masked-or-value number: `null` renders N/A (never 0 for a div-by-zero). */
export type Maybe = number | null;

/** Top-package-by-dimension row. */
export interface TopPackageRow {
  /** The dimension value (incl. first-class `unknown` / `other`). */
  value: string;
  /** The winning product for this value. */
  topProduct: string;
  /** The winning product's summed measure. */
  measure: number;
}

/** DAU/WAU/MAU + stickiness view. */
export interface ActiveUsersView {
  gameId: string;
  day: string;
  dau: Maybe;
  wau: Maybe;
  mau: Maybe;
  stickiness: Maybe;
  provisional: boolean;
}

/** ARPU/ARPPU/ARPDAU/conversion view (day-grain). */
export interface RevenueKpiView {
  gameId: string;
  day: string;
  revenue: number;
  dau: Maybe;
  payingUsers: Maybe;
  arpu: Maybe;
  arppu: Maybe;
  arpdau: Maybe;
  conversion: Maybe;
  provisional: boolean;
}

/** Whale-concentration view for a period. */
export interface WhaleView {
  gameId: string;
  period: string;
  payingUsers: number;
  revenue: number;
  cohorts: Array<{ percent: number; share: Maybe }>;
  lowConfidence: boolean;
  /** Payers with an unconverted (parked) floor — surfaced separately, not folded in. */
  indeterminatePayers: number;
}

@Injectable()
export class MonetizationReadService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly dataSource: DataSource,
    private readonly config: MonetizationConfigService,
  ) {}

  // ==== Monetization dashboard ================================================

  /**
   * Top package by dimension `D` for a day range (inclusive). For each value of `D`,
   * rank products by summed `measure` (revenue|count), marginalizing other dims. Reads
   * MONETIZATION_CELL rows whose dim_combo contains a `D=` component. `unknown`/`other`
   * are first-class values.
   */
  async topPackageByDimension(
    gameId: string,
    dimension: string,
    from: string,
    to: string,
    measure: 'revenue' | 'count',
  ): Promise<TopPackageRow[]> {
    const cells = await this.dataSource.getRepository(MonetizationCellEntity).find({
      where: { gameId },
      select: { productId: true, dimCombo: true, utcDay: true, purchaseCount: true, revenueNormalized: true },
    });
    // value → product → summed measure
    const byValue = new Map<string, Map<string, number>>();
    for (const cell of cells) {
      if (cell.utcDay < from || cell.utcDay > to) {
        continue;
      }
      if (!dimComboHas(cell.dimCombo, dimension)) {
        continue;
      }
      const value = parseDimCombo(cell.dimCombo)[dimension]!;
      const m = measure === 'revenue' ? Number(cell.revenueNormalized) : Number(cell.purchaseCount);
      const products = byValue.get(value) ?? new Map<string, number>();
      products.set(cell.productId, (products.get(cell.productId) ?? 0) + m);
      byValue.set(value, products);
    }
    const rows: TopPackageRow[] = [];
    for (const [value, products] of byValue) {
      let topProduct = '';
      let best = -Infinity;
      for (const [product, sum] of products) {
        if (sum > best) {
          best = sum;
          topProduct = product;
        }
      }
      rows.push({ value, topProduct, measure: best === -Infinity ? 0 : best });
    }
    return rows.sort((a, b) => b.measure - a.measure);
  }

  /**
   * Context-coverage health per client-only dim D over a day range: `1 −
   * measure(D=unknown) / measure(total)`. Signals companion-delivery health.
   */
  async contextCoverage(gameId: string, from: string, to: string): Promise<Record<string, Maybe>> {
    const dims = await this.config.clientDimensions(gameId);
    const cells = await this.dataSource.getRepository(MonetizationCellEntity).find({
      where: { gameId },
      select: { dimCombo: true, utcDay: true, revenueNormalized: true },
    });
    const out: Record<string, Maybe> = {};
    for (const dim of dims) {
      let total = 0;
      let unknown = 0;
      for (const cell of cells) {
        if (cell.utcDay < from || cell.utcDay > to || !dimComboHas(cell.dimCombo, dim)) {
          continue;
        }
        const rev = Number(cell.revenueNormalized);
        total += rev;
        if (parseDimCombo(cell.dimCombo)[dim] === 'unknown') {
          unknown += rev;
        }
      }
      out[dim] = total === 0 ? null : 1 - unknown / total;
    }
    return out;
  }

  // ==== Active users (007) ====================================================

  /** DAU/WAU/MAU + stickiness for a day. Windows masked N/A until fully elapsed. */
  async activeUsers(gameId: string, day: string): Promise<ActiveUsersView> {
    const mauWindow = await this.config.mauWindowDays(gameId);
    const mask = await this.config.partialWindowMask(gameId);
    const today = this.config.todayLogical();
    const provisional = day >= today;

    const dau = await this.distinctActive(gameId, day, day, provisional);
    const wauFrom = this.addDays(day, -(WAU_WINDOW_DAYS - 1));
    const mauFrom = this.addDays(day, -(mauWindow - 1));

    // Masking: WAU/MAU render N/A until the window has fully elapsed since the game's
    // earliest active day (partial_window_mask).
    const earliest = await this.earliestActiveDay(gameId);
    const wauReady = !mask || (earliest !== null && this.dayGap(earliest, day) >= WAU_WINDOW_DAYS - 1);
    const mauReady = !mask || (earliest !== null && this.dayGap(earliest, day) >= mauWindow - 1);

    const wau = wauReady ? await this.distinctActive(gameId, wauFrom, day, provisional) : null;
    const mau = mauReady ? await this.distinctActive(gameId, mauFrom, day, provisional) : null;
    const stickiness = dau !== null && mau !== null && mau > 0 ? dau / mau : null;

    return { gameId, day, dau, wau, mau, stickiness, provisional };
  }

  // ==== Revenue KPIs (007) ====================================================

  /** ARPU/ARPPU/ARPDAU/conversion for a day. Div-by-0 → N/A. */
  async revenueKpis(gameId: string, day: string): Promise<RevenueKpiView> {
    const today = this.config.todayLogical();
    const provisional = day >= today;
    const revenue = await this.dayRevenue(gameId, day, provisional);
    const dau = await this.distinctActive(gameId, day, day, provisional);
    const payingUsers = await this.distinctPayers(gameId, day, day, provisional);

    const arpu = dau !== null && dau > 0 ? revenue / dau : null;
    const arppu = payingUsers !== null && payingUsers > 0 ? revenue / payingUsers : null;
    const arpdau = dau !== null && dau > 0 ? revenue / dau : null;
    const conversion = dau !== null && dau > 0 && payingUsers !== null ? payingUsers / dau : null;

    return { gameId, day, revenue, dau, payingUsers, arpu, arppu, arpdau, conversion, provisional };
  }

  /** First-purchase conversion for a day range: count(first_purchase_day ∈ P) / denom. */
  async firstPurchaseConversion(gameId: string, from: string, to: string): Promise<Maybe> {
    const count = await this.dataSource
      .getRepository(PayerSpineExtEntity)
      .createQueryBuilder('p')
      .where('p.game_id = :gameId', { gameId })
      .andWhere('p.first_purchase_day >= :from', { from })
      .andWhere('p.first_purchase_day <= :to', { to })
      .getCount();
    const denomMode = await this.config.firstPurchaseDenominator(gameId);
    const denom =
      denomMode === 'new_users'
        ? await this.newUsers(gameId, from, to)
        : await this.distinctActive(gameId, from, to, false);
    if (denom === null || denom === 0) {
      return null;
    }
    return count / denom;
  }

  /** New vs returning composition for a day (disjoint, sums to DAU). */
  async newReturning(gameId: string, day: string): Promise<{ new: number; returning: number; dau: Maybe }> {
    const activeMembers = await this.activeMembers(gameId, day, day, day >= this.config.todayLogical());
    if (activeMembers.size === 0) {
      return { new: 0, returning: 0, dau: 0 };
    }
    // Which of the active users have first_seen == day → new; else returning.
    const spineRows = await this.dataSource
      .getRepository(UserSpineEntity)
      .createQueryBuilder('u')
      .select('u.user_id', 'user_id')
      .addSelect('u.first_seen', 'first_seen')
      .where('u.game_id = :gameId', { gameId })
      .andWhere('u.user_id IN (:...ids)', { ids: [...activeMembers] })
      .getRawMany<{ user_id: string; first_seen: Date }>();
    let newCount = 0;
    for (const r of spineRows) {
      if (this.config.logicalDayOf(new Date(r.first_seen).getTime()) === day) {
        newCount += 1;
      }
    }
    const returning = activeMembers.size - newCount;
    return { new: newCount, returning, dau: activeMembers.size };
  }

  // ==== Whale concentration (007) =============================================

  /**
   * Whale concentration for a period (YYYY-MM). Rank PAYER_PERIOD_SPEND desc, take top
   * ⌈X%·payers⌉, ÷ Revenue(M). low_confidence when payers < whale_min_payers. Payers
   * with an outstanding parked (indeterminate) floor are surfaced separately. Div-by-0
   * / a percentile rounding to 0 payers → N/A.
   */
  async whaleConcentration(gameId: string, period: string): Promise<WhaleView> {
    const rows = await this.dataSource.getRepository(PayerPeriodSpendEntity).find({
      where: { gameId, period },
      select: { userId: true, spendNormalized: true },
    });
    const spends = rows
      .map((r) => Number(r.spendNormalized))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => b - a);
    const payingUsers = spends.length;
    const revenue = spends.reduce((s, v) => s + v, 0);
    const percents = await this.config.whaleTopPercents(gameId);
    const minPayers = await this.config.whaleMinPayers(gameId);

    const cohorts = percents.map((percent) => {
      const k = Math.ceil((percent / 100) * payingUsers);
      if (k <= 0 || revenue <= 0) {
        return { percent, share: null };
      }
      const topSum = spends.slice(0, k).reduce((s, v) => s + v, 0);
      return { percent, share: topSum / revenue };
    });

    // indeterminate payers: those with an outstanding parked floor this game.
    const indeterminatePayers = await this.dataSource
      .getRepository(PayerSpineExtEntity)
      .count({ where: { gameId, hasUnconvertedSpend: true } });

    return {
      gameId,
      period,
      payingUsers,
      revenue,
      cohorts,
      lowConfidence: payingUsers < minPayers,
      indeterminatePayers,
    };
  }

  // ==== Shared distinct-set / revenue helpers (live-vs-flushed merge) =========

  /** Distinct active user count over [from,to], merging live `act` set on the open day. */
  private async distinctActive(gameId: string, from: string, to: string, includeLive: boolean): Promise<Maybe> {
    const members = await this.activeMembers(gameId, from, to, includeLive);
    return members.size;
  }

  /** The distinct active user SET over [from,to] (durable ∪ live act on open days). */
  private async activeMembers(gameId: string, from: string, to: string, includeLive: boolean): Promise<Set<string>> {
    const set = new Set<string>();
    const rows = await this.dataSource
      .getRepository(ActiveUserDayEntity)
      .createQueryBuilder('a')
      .where('a.game_id = :gameId', { gameId })
      .andWhere('a.utc_day >= :from', { from })
      .andWhere('a.utc_day <= :to', { to })
      .getMany();
    for (const row of rows) {
      for (const u of Object.keys(row.members ?? {})) {
        set.add(u);
      }
    }
    if (includeLive) {
      const today = this.config.todayLogical();
      if (today >= from && today <= to) {
        const live = await this.redis.hgetall(`${gameId}:act:${today}`);
        for (const field of Object.keys(live)) {
          if (field !== SEEDED_MARKER_FIELD) {
            set.add(field);
          }
        }
      }
    }
    return set;
  }

  /** Distinct payer count over [from,to] (durable payer_members ∪ live payer set). */
  private async distinctPayers(gameId: string, from: string, to: string, includeLive: boolean): Promise<Maybe> {
    const set = new Set<string>();
    const rows = await this.dataSource
      .getRepository(PayerDayEntity)
      .createQueryBuilder('p')
      .where('p.game_id = :gameId', { gameId })
      .andWhere('p.utc_day >= :from', { from })
      .andWhere('p.utc_day <= :to', { to })
      .getMany();
    for (const row of rows) {
      for (const u of Object.keys(row.payerMembers ?? {})) {
        set.add(u);
      }
    }
    if (includeLive) {
      const today = this.config.todayLogical();
      if (today >= from && today <= to) {
        const live = await this.redis.hgetall(PayerKeys.members(gameId, today));
        for (const field of Object.keys(live)) {
          if (field !== SEEDED_MARKER_FIELD) {
            set.add(field);
          }
        }
      }
    }
    return set.size;
  }

  /** Day revenue: durable PAYER_DAY.revenue_day_total, live-merged (GREATEST) on open day. */
  private async dayRevenue(gameId: string, day: string, includeLive: boolean): Promise<number> {
    const durable = await this.dataSource.getRepository(PayerDayEntity).findOne({
      where: { gameId, utcDay: day },
      select: { revenueDayTotal: true },
    });
    let value = durable ? Number(durable.revenueDayTotal) : 0;
    if (includeLive) {
      const today = this.config.todayLogical();
      if (day === today) {
        const live = await this.redis.hget(RevKeys.day(gameId, day), REV_TOTAL_FIELD);
        if (live !== null) {
          const liveVal = Number(live);
          // Live rehydrated from the durable floor → GREATEST (never sum the floor twice).
          value = Math.max(value, Number.isFinite(liveVal) ? liveVal : 0);
        }
      }
    }
    return value;
  }

  /** Period revenue = Σ day revenue over the period's days (durable). */
  async periodRevenue(gameId: string, period: string): Promise<number> {
    const rows = await this.dataSource
      .getRepository(PayerDayEntity)
      .createQueryBuilder('p')
      .where('p.game_id = :gameId', { gameId })
      .andWhere("to_char(p.utc_day, 'YYYY-MM') = :period", { period })
      .select('p.revenue_day_total', 'revenue_day_total')
      .getRawMany<{ revenue_day_total: string }>();
    return rows.reduce((s, r) => s + Number(r.revenue_day_total), 0);
  }

  /** New users over [from,to]: distinct user_ids with first_seen ∈ [from,to]. */
  private async newUsers(gameId: string, from: string, to: string): Promise<number> {
    return this.dataSource
      .getRepository(UserSpineEntity)
      .createQueryBuilder('u')
      .where('u.game_id = :gameId', { gameId })
      .andWhere('u.first_seen >= :from', { from: `${from}T00:00:00Z` })
      .andWhere('u.first_seen < :to', { to: `${this.addDays(to, 1)}T00:00:00Z` })
      .getCount();
  }

  /** The game's earliest durable active day (for partial-window masking), or null. */
  private async earliestActiveDay(gameId: string): Promise<string | null> {
    const row = await this.dataSource
      .getRepository(ActiveUserDayEntity)
      .createQueryBuilder('a')
      .where('a.game_id = :gameId', { gameId })
      .select('MIN(a.utc_day)', 'min')
      .getRawOne<{ min: string | null }>();
    return row?.min ?? null;
  }

  private addDays(day: string, delta: number): string {
    const ms = Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000;
    return new Date(ms).toISOString().slice(0, 10);
  }

  private dayGap(a: string, b: string): number {
    return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
  }

  /** Expose the period-of-day helper for controllers. */
  periodOf(day: string): string {
    return periodOfDay(day);
  }

  /** Read the mon cell key parse (for tests). */
  static parseCell(key: string): { productId: string; dimCombo: string } | null {
    return parseCellKey(key);
  }
}
