/**
 * Monetization metric controller (T-11.55-61) — GET /panel/:gameId/monetization.
 * Reads {@link MonetizationReadService}: top package by the selected dimension,
 * per-day revenue series, context coverage, whale concentration, and the day-grain
 * revenue KPIs. The dimension selector swaps via ?dim=.
 */

import { Controller, Get, Param, Query, Render, Req, UseGuards } from '@nestjs/common';
import { MonetizationReadService } from '../../monetization/monetization-read.service';
import { PanelConfigService } from '../panel-config.service';
import { CredentialService } from '../../operator/credential.service';
import { GameConfigService, GAME_CONFIG_DEFAULTS } from '../../config/game-config.service';
import { CurrentOperator } from '../../operator/current-operator.decorator';
import type { OperatorSession } from '../../operator/operator-session.service';
import { PanelSessionGuard } from '../auth/panel-session.guard';
import { GameAccessGuard, type GameScopedRequest } from '../auth/game-access.guard';
import { resolvePeriod } from '../dashboard/period';
import { fmtMoney, fmtPercent, type ChartConfig } from '../view-model';

@Controller('panel')
@UseGuards(PanelSessionGuard)
export class MonetizationController {
  constructor(
    private readonly monetization: MonetizationReadService,
    private readonly panelConfig: PanelConfigService,
    private readonly credentials: CredentialService,
    private readonly gameConfig: GameConfigService,
  ) {}

  @Get(':gameId/monetization')
  @UseGuards(GameAccessGuard)
  @Render('metrics/monetization')
  async view(
    @CurrentOperator() operator: OperatorSession,
    @Param('gameId') gameId: string,
    @Query('period') period: string | undefined,
    @Query('dim') dimParam: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() req: GameScopedRequest,
  ): Promise<Record<string, unknown>> {
    const s = this.panelConfig.settings();
    const resolved = resolvePeriod(period, from, to);
    const dimensionsRaw = await this.gameConfig.getConfig(gameId);
    const dimensions: string[] = (dimensionsRaw['monetization_dimensions'] as string[] | undefined) ?? [
      ...GAME_CONFIG_DEFAULTS.monetization_dimensions,
    ];
    const dimension = dimParam && dimensions.includes(dimParam) ? dimParam : (dimensions[0] ?? 'region');

    const [topByDim, coverage, revKpis, whale] = await Promise.all([
      this.monetization.topPackageByDimension(gameId, dimension, resolved.from, resolved.to, 'revenue'),
      this.monetization.contextCoverage(gameId, resolved.from, resolved.to),
      this.monetization.revenueKpis(gameId, resolved.to),
      this.monetization.whaleConcentration(gameId, resolved.to.slice(0, 7)),
    ]);

    // Revenue-by-dimension-value bar chart.
    const revChart: ChartConfig = {
      type: 'bar',
      data: {
        labels: topByDim.map((r) => r.value),
        datasets: [
          {
            label: `Revenue by ${dimension}`,
            data: topByDim.map((r) => Math.round(r.measure * 100) / 100),
            backgroundColor: s.chartColorPrimary,
          },
        ],
      },
      options: { scales: { y: { beginAtZero: true } }, plugins: { legend: { display: false } } },
    };

    const coverageRows = Object.entries(coverage).map(([dim, val]) => ({ dim, value: fmtPercent(val) }));

    const gameName = req.game?.name ?? gameId;
    const games = await this.credentials.listGames();
    return {
      panelTitle: s.panelTitle,
      logoUrl: s.logoUrl,
      operator,
      games,
      nav: 'monetization',
      gameId,
      gameName,
      pageTitle: `${gameName} · Monetization`,
      breadcrumb: [
        { label: 'Games', href: '/panel/games' },
        { label: gameName, href: `/panel/${gameId}/settings` },
        { label: 'Monetization' },
      ],
      period: resolved.preset,
      dimensions,
      dimension,
      summary: {
        revenue: fmtMoney(revKpis.revenue),
        arppu: fmtMoney(revKpis.arppu),
        conversion: fmtPercent(revKpis.conversion),
        payingUsers: revKpis.payingUsers === null ? 'N/A' : String(revKpis.payingUsers),
      },
      provisional: resolved.includesToday,
      topByDim: topByDim.map((r) => ({ value: r.value, topProduct: r.topProduct, revenue: fmtMoney(r.measure) })),
      coverageRows,
      revChart,
      whale: {
        payingUsers: whale.payingUsers,
        revenue: fmtMoney(whale.revenue),
        lowConfidence: whale.lowConfidence,
        indeterminatePayers: whale.indeterminatePayers,
        cohorts: whale.cohorts.map((c) => ({ percent: c.percent, share: fmtPercent(c.share) })),
      },
      hasData: revKpis.revenue > 0 || topByDim.length > 0,
    };
  }
}
