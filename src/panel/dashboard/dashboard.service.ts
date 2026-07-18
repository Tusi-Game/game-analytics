/**
 * Panel dashboard service (T-11.25/26/38-42) — orchestrates the per-game overview
 * by CONSUMING the sibling read services (which already implement the Foundation
 * §3.3 sealed-vs-live merge). The panel does NOT re-derive the merge; the ONLY new
 * read-time derivation here is the previous-period trend delta (spec §2.3), plus
 * shaping the results into template-ready view models.
 *
 * Pure reader (P9): every dependency is a read service; nothing is written.
 */

import { Injectable } from '@nestjs/common';
import { ReadModelService } from '../../dashboard/read-model.service';
import { ExceptionReadService } from '../../dashboard/exception-read.service';
import { SessionReadService } from '../../sessions/session-read.service';
import { MonetizationReadService } from '../../monetization/monetization-read.service';
import { computeTrend } from './trend';
import { enumeratePeriodDays, type ResolvedPeriod } from './period';
import { fmtCompact, fmtCount, fmtMoney, fmtPercent, type ChartConfig, type MetricCard } from '../view-model';

/** The assembled dashboard overview view model. */
export interface DashboardOverview {
  cards: MetricCard[];
  eventChart: ChartConfig;
  topEvents: Array<{ name: string; count: number; pct: string }>;
  exceptions: { total: number; perReason: Array<{ reason: string; count: number }>; provisional: boolean };
  provisional: boolean;
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly readModel: ReadModelService,
    private readonly exceptions: ExceptionReadService,
    private readonly sessions: SessionReadService,
    private readonly monetization: MonetizationReadService,
  ) {}

  /**
   * Build the overview for a game over a resolved period. Reads active-users +
   * revenue KPIs at the period end-day (day-grain KPIs, live-merged by the read
   * service), event counts + sessions summed over the window, and computes trend
   * deltas against the preceding equal-length window's end-day.
   */
  async overview(
    gameId: string,
    period: ResolvedPeriod,
    topNEvents: number,
    chartColor: string,
  ): Promise<DashboardOverview> {
    const days = enumeratePeriodDays(period.from, period.to);
    const endDay = period.to;
    const prevEndDay = period.prevTo;

    const [active, revenue, prevActive, prevRevenue] = await Promise.all([
      this.monetization.activeUsers(gameId, endDay),
      this.monetization.revenueKpis(gameId, endDay),
      this.monetization.activeUsers(gameId, prevEndDay),
      this.monetization.revenueKpis(gameId, prevEndDay),
    ]);

    // Event counts over the window (Σ liveTotal per day; per-name for top events).
    const perNameTotals = new Map<string, number>();
    let eventTotal = 0;
    let eventsProvisional = false;
    const eventSeries: number[] = [];
    for (const day of days) {
      const dc = await this.readModel.dayCounts(gameId, day);
      eventTotal += dc.liveTotal;
      eventsProvisional = eventsProvisional || dc.provisional;
      eventSeries.push(dc.liveTotal);
      for (const [name, count] of Object.entries(dc.perName)) {
        perNameTotals.set(name, (perNameTotals.get(name) ?? 0) + count);
      }
    }

    // Sessions over the window (Σ session_count; end-day for the 24h card).
    let sessionsWindowTotal = 0;
    let sessionsProvisional = false;
    for (const day of days) {
      const sd = await this.sessions.sessionDay(gameId, day);
      sessionsWindowTotal += sd.sessionCount;
      sessionsProvisional = sessionsProvisional || sd.provisional;
    }

    const provisional = period.includesToday;

    const cards: MetricCard[] = [
      {
        label: 'DAU',
        value: fmtCount(active.dau),
        trend: computeTrend(active.dau, prevActive.dau),
        provisional,
      },
      {
        label: 'MAU',
        value: fmtCount(active.mau),
        trend: computeTrend(active.mau, prevActive.mau),
        provisional,
      },
      {
        label: 'Stickiness',
        value: fmtPercent(active.stickiness),
        trend: computeTrend(active.stickiness, prevActive.stickiness),
        provisional,
      },
      {
        label: 'ARPDAU',
        value: fmtMoney(revenue.arpdau),
        trend: computeTrend(revenue.arpdau, prevRevenue.arpdau),
        provisional,
      },
      { label: 'Events', value: fmtCompact(eventTotal), provisional: eventsProvisional },
      { label: 'Sessions', value: fmtCompact(sessionsWindowTotal), provisional: sessionsProvisional },
      {
        label: 'Revenue',
        value: fmtMoney(revenue.revenue),
        trend: computeTrend(revenue.revenue, prevRevenue.revenue),
        provisional,
      },
      {
        label: 'ARPPU',
        value: fmtMoney(revenue.arppu),
        trend: computeTrend(revenue.arppu, prevRevenue.arppu),
        provisional,
      },
    ];

    // Top events over the window, limited to top_n_events.
    const topEventRows = [...perNameTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, topNEvents))
      .map(([name, count]) => ({
        name,
        count,
        pct: eventTotal > 0 ? fmtPercent(count / eventTotal) : 'N/A',
      }));

    const eventChart: ChartConfig = {
      type: 'line',
      data: {
        labels: days,
        datasets: [
          {
            label: 'Events',
            data: eventSeries,
            borderColor: chartColor,
            backgroundColor: 'rgba(79,70,229,0.12)',
            fill: true,
            tension: 0.3,
            pointRadius: 2,
          },
        ],
      },
      options: { scales: { y: { beginAtZero: true } }, plugins: { legend: { display: false } } },
    };

    // Exceptions for the period end-day (today's tally on the overview card).
    const exc = await this.exceptions.exceptionDay(gameId, endDay);
    const perReason = Object.entries(exc.perReason)
      .filter(([, c]) => (c ?? 0) > 0)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .map(([reason, count]) => ({ reason, count: count ?? 0 }));

    return {
      cards,
      eventChart,
      topEvents: topEventRows,
      exceptions: { total: exc.total, perReason, provisional: exc.provisional },
      provisional,
    };
  }
}
