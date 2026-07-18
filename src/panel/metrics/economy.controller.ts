/**
 * Economy metric controller (T-11.44-50) — GET /panel/:gameId/economy. Reads
 * {@link EconomyReadService} (net flow / sink ratio / faucets / drains / currency
 * breakdown / money-supply trend) — all §3.3-merged in the read service; the panel
 * renders the amber provisional badge where a view's `provisional` flag is set.
 */

import { Controller, Get, Param, Query, Render, Req, UseGuards } from '@nestjs/common';
import { EconomyReadService } from '../../economy/economy-read.service';
import { PanelConfigService } from '../panel-config.service';
import { CredentialService } from '../../operator/credential.service';
import { GameConfigService, GAME_CONFIG_DEFAULTS } from '../../config/game-config.service';
import { CurrentOperator } from '../../operator/current-operator.decorator';
import type { OperatorSession } from '../../operator/operator-session.service';
import { PanelSessionGuard } from '../auth/panel-session.guard';
import { GameAccessGuard, type GameScopedRequest } from '../auth/game-access.guard';
import { resolvePeriod, enumeratePeriodDays } from '../dashboard/period';
import { fmtCount, fmtPercent, type ChartConfig } from '../view-model';

@Controller('panel')
@UseGuards(PanelSessionGuard)
export class EconomyController {
  constructor(
    private readonly economy: EconomyReadService,
    private readonly panelConfig: PanelConfigService,
    private readonly credentials: CredentialService,
    private readonly gameConfig: GameConfigService,
  ) {}

  @Get(':gameId/economy')
  @UseGuards(GameAccessGuard)
  @Render('metrics/economy')
  async view(
    @CurrentOperator() operator: OperatorSession,
    @Param('gameId') gameId: string,
    @Query('period') period: string | undefined,
    @Query('currency') currencyParam: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() req: GameScopedRequest,
  ): Promise<Record<string, unknown>> {
    const s = this.panelConfig.settings();
    const resolved = resolvePeriod(period, from, to);
    const days = enumeratePeriodDays(resolved.from, resolved.to);
    const currencies = await this.economy.currencies(gameId);
    const currency = currencyParam && currencies.includes(currencyParam) ? currencyParam : (currencies[0] ?? 'USD');

    // Per-day net-flow chart + aggregate summary over the window.
    const sourceSeries: number[] = [];
    const sinkSeries: number[] = [];
    const netSeries: number[] = [];
    let totalSource = 0;
    let totalSink = 0;
    let provisional = false;
    let lowVolume = false;
    let lastFaucets: Array<{ reason: string; amount: number }> = [];
    let lastDrains: Array<{ reason: string; amount: number }> = [];
    for (const day of days) {
      const view = await this.economy.economyDay(gameId, currency, day);
      sourceSeries.push(view.totalSource);
      sinkSeries.push(view.totalSink);
      netSeries.push(view.netFlow);
      totalSource += view.totalSource;
      totalSink += view.totalSink;
      provisional = provisional || view.provisional;
      lowVolume = lowVolume || view.lowVolume;
      lastFaucets = view.topFaucets;
      lastDrains = view.topDrains;
    }

    const netFlow = totalSource - totalSink;
    const sinkRatio = totalSource === 0 ? null : totalSink / totalSource;

    const depthMode =
      (await this.gameConfig.getString(gameId, 'economy_depth_capture_mode')) ??
      GAME_CONFIG_DEFAULTS.economy_depth_capture_mode;
    let supplyTrend: Array<{ utcDay: string; moneySupply: number; cumulativeNetFlow: number }> = [];
    if (depthMode !== 'off') {
      // Degrade gracefully: the money-supply trend is an optional diagnostic. If
      // the read fails (e.g. no supply rows / read-service edge case), drop the
      // chart rather than 500 the whole economy view.
      try {
        supplyTrend = await this.economy.supplyTrend(gameId, currency, resolved.from, resolved.to);
      } catch {
        supplyTrend = [];
      }
    }

    const netFlowChart: ChartConfig = {
      type: 'line',
      data: {
        labels: days,
        datasets: [
          {
            label: 'Sources',
            data: sourceSeries,
            borderColor: '#10b981',
            backgroundColor: 'rgba(16,185,129,0.15)',
            fill: true,
            tension: 0.3,
          },
          {
            label: 'Sinks',
            data: sinkSeries,
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239,68,68,0.15)',
            fill: true,
            tension: 0.3,
          },
          {
            label: 'Net flow',
            data: netSeries,
            borderColor: '#0f172a',
            borderDash: [5, 4],
            fill: false,
            tension: 0.3,
            pointRadius: 0,
          },
        ],
      },
      options: { scales: { y: { beginAtZero: true } } },
    };

    const supplyChart: ChartConfig | null = supplyTrend.length
      ? {
          type: 'line',
          data: {
            labels: supplyTrend.map((p) => p.utcDay),
            datasets: [
              {
                label: 'Measured supply',
                data: supplyTrend.map((p) => p.moneySupply),
                borderColor: s.chartColorPrimary,
                tension: 0.3,
              },
              {
                label: 'Cumulative-flow-implied',
                data: supplyTrend.map((p) => p.cumulativeNetFlow),
                borderColor: '#f59e0b',
                borderDash: [5, 4],
                tension: 0.3,
              },
            ],
          },
          options: { scales: { y: { beginAtZero: true } } },
        }
      : null;

    const gameName = req.game?.name ?? gameId;
    const games = await this.credentials.listGames();
    return {
      panelTitle: s.panelTitle,
      logoUrl: s.logoUrl,
      operator,
      games,
      nav: 'economy',
      gameId,
      gameName,
      pageTitle: `${gameName} · Economy`,
      breadcrumb: [
        { label: 'Games', href: '/panel/games' },
        { label: gameName, href: `/panel/${gameId}/settings` },
        { label: 'Economy' },
      ],
      period: resolved.preset,
      currencies,
      currency,
      summary: {
        totalSource: fmtCount(totalSource),
        totalSink: fmtCount(totalSink),
        netFlow: fmtCount(netFlow),
        sinkRatio: fmtPercent(sinkRatio),
      },
      lowVolume,
      provisional,
      topFaucets: lastFaucets,
      topDrains: lastDrains,
      netFlowChart,
      supplyChart,
      hasData: totalSource > 0 || totalSink > 0,
    };
  }
}
