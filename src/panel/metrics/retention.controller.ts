/**
 * Retention metric controller (T-11.51-54) — GET /panel/:gameId/retention.
 * Explicit "Classic Day-N Retention" label (FR-017). Reads
 * {@link RetentionReadService.headline} (D1/D7/D30 over the fixed mature-cohort
 * set) + `.heatmap` (cohort × offset with immature→N/A and small-cohort masks).
 * Immature cells render "N/A" (never a misleading low number).
 */

import { Controller, Get, Param, Render, Req, UseGuards } from '@nestjs/common';
import { RetentionReadService } from '../../sessions/retention-read.service';
import { PanelConfigService } from '../panel-config.service';
import { CredentialService } from '../../operator/credential.service';
import { CurrentOperator } from '../../operator/current-operator.decorator';
import type { OperatorSession } from '../../operator/operator-session.service';
import { PanelSessionGuard } from '../auth/panel-session.guard';
import { GameAccessGuard, type GameScopedRequest } from '../auth/game-access.guard';
import { fmtPercent, type ChartConfig } from '../view-model';

@Controller('panel')
@UseGuards(PanelSessionGuard)
export class RetentionController {
  constructor(
    private readonly retention: RetentionReadService,
    private readonly panelConfig: PanelConfigService,
    private readonly credentials: CredentialService,
  ) {}

  @Get(':gameId/retention')
  @UseGuards(GameAccessGuard)
  @Render('metrics/retention')
  async view(
    @CurrentOperator() operator: OperatorSession,
    @Param('gameId') gameId: string,
    @Req() req: GameScopedRequest,
  ): Promise<Record<string, unknown>> {
    const s = this.panelConfig.settings();
    const [headline, heatmap, games] = await Promise.all([
      this.retention.headline(gameId),
      this.retention.heatmap(gameId),
      this.credentials.listGames(),
    ]);

    // Offsets present in the heatmap (sorted), and cohort rows (newest first).
    const offsets = [...new Set(heatmap.map((c) => c.offset))].sort((a, b) => a - b);
    const cohortDates = [...new Set(heatmap.map((c) => c.cohortDate))].sort((a, b) => (a < b ? 1 : -1));
    const cellByKey = new Map(heatmap.map((c) => [`${c.cohortDate}:${c.offset}`, c]));

    const rows = cohortDates.map((cohortDate) => {
      const first = heatmap.find((c) => c.cohortDate === cohortDate);
      const cells = offsets.map((offset) => {
        const cell = cellByKey.get(`${cohortDate}:${offset}`);
        return {
          offset,
          // Immature → "N/A" (never a misleading number, FR-017).
          display: cell && cell.rate !== null ? fmtPercent(cell.rate) : 'N/A',
          immature: cell?.immature ?? true,
          lowConfidence: cell?.lowConfidence ?? false,
          provisional: cell?.provisional ?? false,
        };
      });
      return { cohortDate, cohortSize: first?.cohortSize ?? 0, lowConfidence: first?.lowConfidence ?? false, cells };
    });

    // Headline curve: rate per offset over the fixed mature-cohort set.
    const curveOffsets = headline.map((h) => h.offset).sort((a, b) => a - b);
    const curveChart: ChartConfig = {
      type: 'line',
      data: {
        labels: [0, ...curveOffsets].map((o) => `D${o}`),
        datasets: [
          {
            label: 'Retention',
            data: [
              100,
              ...curveOffsets.map((o) => {
                const h = headline.find((x) => x.offset === o);
                return h && h.rate !== null ? Math.round(h.rate * 1000) / 10 : null;
              }),
            ],
            borderColor: s.chartColorPrimary,
            backgroundColor: 'rgba(79,70,229,0.12)',
            fill: true,
            tension: 0.3,
            spanGaps: true,
          },
        ],
      },
      options: { scales: { y: { beginAtZero: true, max: 100 } }, plugins: { legend: { display: false } } },
    };

    const headlineCards = headline.map((h) => ({ label: `D${h.offset}`, value: fmtPercent(h.rate) }));
    const gameName = req.game?.name ?? gameId;
    return {
      panelTitle: s.panelTitle,
      logoUrl: s.logoUrl,
      operator,
      games,
      nav: 'retention',
      gameId,
      gameName,
      pageTitle: `${gameName} · Retention`,
      breadcrumb: [
        { label: 'Games', href: '/panel/games' },
        { label: gameName, href: `/panel/${gameId}/settings` },
        { label: 'Retention' },
      ],
      offsets,
      rows,
      curveChart,
      headlineCards,
      hasData: rows.length > 0,
    };
  }
}
