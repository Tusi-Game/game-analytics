/**
 * Dashboard read-model endpoint STUB (T-01.41). A thin JSON surface over
 * {@link ReadModelService} so the live-vs-historical merge is reachable; the full
 * panel (spec 012) builds the rich UI on top. Guarded by the operator session
 * guard (dashboard is operator-facing, not public ingest).
 */

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { OperatorSessionGuard } from '../common/guards/operator-session.guard';
import { ReadModelService, type DayCounts } from './read-model.service';
import { utcDay } from '../common/kernel/logical-day';
import { SessionReadService, type SessionDayView, type SessionWindowView } from '../sessions/session-read.service';
import { RetentionReadService, type HeadlineView, type RetentionCellView } from '../sessions/retention-read.service';
import {
  EconomyReadService,
  type EconomyDayView,
  type MoneySupplyView,
  type SupplyTrendPoint,
} from '../economy/economy-read.service';
import {
  MonetizationReadService,
  type ActiveUsersView,
  type RevenueKpiView,
  type TopPackageRow,
  type WhaleView,
  type Maybe,
} from '../monetization/monetization-read.service';

@Controller('v1/dashboard')
@UseGuards(OperatorSessionGuard)
export class ReadModelController {
  constructor(
    private readonly readModel: ReadModelService,
    private readonly sessionRead: SessionReadService,
    private readonly retentionRead: RetentionReadService,
    // 004-economy read surface (appended additively).
    private readonly economyRead: EconomyReadService,
    // 006-monetization + 007-derived-kpis read surface (appended additively).
    private readonly monetizationRead: MonetizationReadService,
  ) {}

  /**
   * `GET /v1/dashboard/:gameId/counts?day=YYYY-MM-DD` — merged per-name day counts
   * (live Redis ∪ durable Postgres) + read-time Σ grand total. `day` defaults to
   * the current UTC day when omitted.
   */
  @Get(':gameId/counts')
  async counts(@Param('gameId') gameId: string, @Query('day') day?: string): Promise<DayCounts> {
    const resolvedDay = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : utcDay(Date.now());
    return this.readModel.dayCounts(gameId, resolvedDay);
  }

  /**
   * `GET /v1/dashboard/:gameId/sessions?day=YYYY-MM-DD` — per-day session count,
   * split-form average length, and provisional flag.
   */
  @Get(':gameId/sessions')
  async sessions(@Param('gameId') gameId: string, @Query('day') day?: string): Promise<SessionDayView> {
    const resolvedDay = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : utcDay(Date.now());
    return this.sessionRead.sessionDay(gameId, resolvedDay);
  }

  /**
   * `GET /v1/dashboard/:gameId/sessions/window?from=&to=` — sessions/user +
   * frequency over an inclusive day window.
   */
  @Get(':gameId/sessions/window')
  async sessionWindow(
    @Param('gameId') gameId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<SessionWindowView> {
    const f = /^\d{4}-\d{2}-\d{2}$/.test(from ?? '') ? from : utcDay(Date.now());
    const t = /^\d{4}-\d{2}-\d{2}$/.test(to ?? '') ? to : utcDay(Date.now());
    return this.sessionRead.window(gameId, f, t);
  }

  /**
   * `GET /v1/dashboard/:gameId/retention/headline` — classic Day-N headline
   * (D1/D7/D30…) over the fixed mature-cohort set.
   */
  @Get(':gameId/retention/headline')
  async retentionHeadline(@Param('gameId') gameId: string): Promise<HeadlineView[]> {
    return this.retentionRead.headline(gameId);
  }

  /**
   * `GET /v1/dashboard/:gameId/retention/heatmap` — the cohort × offset triangle
   * with immature (N/A) + small-cohort (low-confidence) masks applied.
   */
  @Get(':gameId/retention/heatmap')
  async retentionHeatmap(@Param('gameId') gameId: string): Promise<RetentionCellView[]> {
    return this.retentionRead.heatmap(gameId);
  }

  // ---- 004-economy read endpoints (appended additively) --------------------

  /**
   * `GET /v1/dashboard/:gameId/economy?currency=&day=&trusted=` — per game ×
   * currency × day source/sink/net/ratio + top faucets/drains, sealed from
   * Postgres, open day live-merged (provisional). `trusted=1` = server-only slice.
   */
  @Get(':gameId/economy')
  async economy(
    @Param('gameId') gameId: string,
    @Query('currency') currency: string,
    @Query('day') day?: string,
    @Query('trusted') trusted?: string,
  ): Promise<EconomyDayView> {
    const resolvedDay = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : utcDay(Date.now());
    return this.economyRead.economyDay(gameId, currency, resolvedDay, {
      provenanceFilter: trusted === '1' ? 'server' : undefined,
    });
  }

  /** `GET /v1/dashboard/:gameId/economy/currencies` — observed currency picker. */
  @Get(':gameId/economy/currencies')
  async economyCurrencies(@Param('gameId') gameId: string): Promise<string[]> {
    return this.economyRead.currencies(gameId);
  }

  /**
   * `GET /v1/dashboard/:gameId/economy/supply?currency=&trusted=` — current money
   * supply + depth (over BALANCE_SNAPSHOT; dormant holders counted).
   */
  @Get(':gameId/economy/supply')
  async economySupply(
    @Param('gameId') gameId: string,
    @Query('currency') currency: string,
    @Query('trusted') trusted?: string,
  ): Promise<MoneySupplyView> {
    return this.economyRead.moneySupply(gameId, currency, {
      provenanceFilter: trusted === '1' ? 'server' : undefined,
    });
  }

  /**
   * `GET /v1/dashboard/:gameId/economy/supply/trend?currency=&from=&to=` —
   * money-supply level trend + cumulative-net-flow divergence diagnostic.
   */
  @Get(':gameId/economy/supply/trend')
  async economySupplyTrend(
    @Param('gameId') gameId: string,
    @Query('currency') currency: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<SupplyTrendPoint[]> {
    const f = /^\d{4}-\d{2}-\d{2}$/.test(from ?? '') ? from : utcDay(Date.now());
    const t = /^\d{4}-\d{2}-\d{2}$/.test(to ?? '') ? to : utcDay(Date.now());
    return this.economyRead.supplyTrend(gameId, currency, f, t);
  }

  // ---- 006-monetization + 007-derived-kpis read endpoints (appended) --------

  /**
   * `GET /v1/dashboard/:gameId/monetization/top?dim=&from=&to=&measure=` — top package
   * by dimension over a day range. `unknown`/`other` are first-class values.
   */
  @Get(':gameId/monetization/top')
  async topPackage(
    @Param('gameId') gameId: string,
    @Query('dim') dim: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('measure') measure?: string,
  ): Promise<TopPackageRow[]> {
    const f = /^\d{4}-\d{2}-\d{2}$/.test(from ?? '') ? from : utcDay(Date.now());
    const t = /^\d{4}-\d{2}-\d{2}$/.test(to ?? '') ? to : utcDay(Date.now());
    return this.monetizationRead.topPackageByDimension(gameId, dim, f, t, measure === 'count' ? 'count' : 'revenue');
  }

  /**
   * `GET /v1/dashboard/:gameId/monetization/coverage?from=&to=` — per client-only-dim
   * context-coverage health (`1 − unknown-revenue / total`). Companion-delivery signal.
   */
  @Get(':gameId/monetization/coverage')
  async contextCoverage(
    @Param('gameId') gameId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<Record<string, Maybe>> {
    const f = /^\d{4}-\d{2}-\d{2}$/.test(from ?? '') ? from : utcDay(Date.now());
    const t = /^\d{4}-\d{2}-\d{2}$/.test(to ?? '') ? to : utcDay(Date.now());
    return this.monetizationRead.contextCoverage(gameId, f, t);
  }

  /**
   * `GET /v1/dashboard/:gameId/kpis/active?day=` — DAU/WAU/MAU + stickiness. WAU/MAU
   * masked N/A until the trailing window has elapsed; today provisional.
   */
  @Get(':gameId/kpis/active')
  async activeUsers(@Param('gameId') gameId: string, @Query('day') day?: string): Promise<ActiveUsersView> {
    const resolvedDay = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : utcDay(Date.now());
    return this.monetizationRead.activeUsers(gameId, resolvedDay);
  }

  /**
   * `GET /v1/dashboard/:gameId/kpis/revenue?day=` — ARPU/ARPPU/ARPDAU/conversion for a
   * day. Div-by-0 → N/A never 0; today provisional.
   */
  @Get(':gameId/kpis/revenue')
  async revenueKpis(@Param('gameId') gameId: string, @Query('day') day?: string): Promise<RevenueKpiView> {
    const resolvedDay = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : utcDay(Date.now());
    return this.monetizationRead.revenueKpis(gameId, resolvedDay);
  }

  /**
   * `GET /v1/dashboard/:gameId/kpis/whale?period=YYYY-MM` — whale concentration for a
   * period. `low_confidence` when payers < whale_min_payers; indeterminate payers
   * surfaced separately. Defaults to the current month.
   */
  @Get(':gameId/kpis/whale')
  async whale(@Param('gameId') gameId: string, @Query('period') period?: string): Promise<WhaleView> {
    const resolvedPeriod = period && /^\d{4}-\d{2}$/.test(period) ? period : utcDay(Date.now()).slice(0, 7);
    return this.monetizationRead.whaleConcentration(gameId, resolvedPeriod);
  }

  /**
   * `GET /v1/dashboard/:gameId/kpis/first-conversion?from=&to=` — first-purchase
   * conversion over a day range (count first_purchase_day ∈ range ÷ denominator).
   */
  @Get(':gameId/kpis/first-conversion')
  async firstConversion(
    @Param('gameId') gameId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<{ value: Maybe }> {
    const f = /^\d{4}-\d{2}-\d{2}$/.test(from ?? '') ? from : utcDay(Date.now());
    const t = /^\d{4}-\d{2}-\d{2}$/.test(to ?? '') ? to : utcDay(Date.now());
    return { value: await this.monetizationRead.firstPurchaseConversion(gameId, f, t) };
  }

  /**
   * `GET /v1/dashboard/:gameId/kpis/composition?day=` — new vs returning DAU split
   * (disjoint, sums to DAU).
   */
  @Get(':gameId/kpis/composition')
  async composition(
    @Param('gameId') gameId: string,
    @Query('day') day?: string,
  ): Promise<{ new: number; returning: number; dau: Maybe }> {
    const resolvedDay = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : utcDay(Date.now());
    return this.monetizationRead.newReturning(gameId, resolvedDay);
  }
}
