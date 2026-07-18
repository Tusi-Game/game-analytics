/**
 * Sessions metric controller (T-11.62-66) — GET /panel/:gameId/sessions. Reads
 * {@link SessionReadService.sessionDay} per day (count / duration / touching) +
 * `.window` (per-user + frequency). Renders the session-count chart, summary
 * cards, and a daily-active-users line with a 7-day rolling average overlay.
 */

import { Controller, Get, Param, Query, Render, Req, UseGuards } from '@nestjs/common';
import { SessionReadService } from '../../sessions/session-read.service';
import { MonetizationReadService } from '../../monetization/monetization-read.service';
import { PanelConfigService } from '../panel-config.service';
import { CredentialService } from '../../operator/credential.service';
import { CurrentOperator } from '../../operator/current-operator.decorator';
import type { OperatorSession } from '../../operator/operator-session.service';
import { PanelSessionGuard } from '../auth/panel-session.guard';
import { GameAccessGuard, type GameScopedRequest } from '../auth/game-access.guard';
import { resolvePeriod, enumeratePeriodDays } from '../dashboard/period';
import { fmtCount, fmtDuration, type ChartConfig } from '../view-model';

@Controller('panel')
@UseGuards(PanelSessionGuard)
export class SessionsController {
  constructor(
    private readonly sessions: SessionReadService,
    private readonly monetization: MonetizationReadService,
    private readonly panelConfig: PanelConfigService,
    private readonly credentials: CredentialService,
  ) {}

  @Get(':gameId/sessions')
  @UseGuards(GameAccessGuard)
  @Render('metrics/sessions')
  async view(
    @CurrentOperator() operator: OperatorSession,
    @Param('gameId') gameId: string,
    @Query('period') period: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() req: GameScopedRequest,
  ): Promise<Record<string, unknown>> {
    const s = this.panelConfig.settings();
    const resolved = resolvePeriod(period, from, to);
    const days = enumeratePeriodDays(resolved.from, resolved.to);

    const countSeries: number[] = [];
    const touchingSeries: number[] = [];
    const dauSeries: number[] = [];
    let totalSessions = 0;
    let totalDurationMs = 0;
    let totalTouching = 0;
    let provisional = false;

    for (const day of days) {
      const sd = await this.sessions.sessionDay(gameId, day);
      countSeries.push(sd.sessionCount);
      touchingSeries.push(sd.sessionsTouching);
      totalSessions += sd.sessionCount;
      totalDurationMs += sd.durationSumMs;
      totalTouching += sd.sessionsTouching;
      provisional = provisional || sd.provisional;
      const active = await this.monetization.activeUsers(gameId, day);
      dauSeries.push(active.dau ?? 0);
    }

    const avgDurationMs = totalTouching > 0 ? totalDurationMs / totalTouching : null;

    // 7-day rolling average of DAU.
    const rolling: Array<number | null> = dauSeries.map((_, i) => {
      if (i < 6) {
        return null;
      }
      let sum = 0;
      for (let j = i - 6; j <= i; j += 1) {
        sum += dauSeries[j] ?? 0;
      }
      return Math.round(sum / 7);
    });

    const countChart: ChartConfig = {
      type: 'bar',
      data: {
        labels: days,
        datasets: [
          { label: 'Sessions (start day)', data: countSeries, backgroundColor: s.chartColorPrimary },
          { label: 'Sessions touching', data: touchingSeries, backgroundColor: 'rgba(148,163,184,0.6)' },
        ],
      },
      options: { scales: { y: { beginAtZero: true } } },
    };

    const dauChart: ChartConfig = {
      type: 'line',
      data: {
        labels: days,
        datasets: [
          { label: 'DAU', data: dauSeries, borderColor: s.chartColorPrimary, tension: 0.3, fill: false },
          {
            label: '7-day avg',
            data: rolling,
            borderColor: '#f59e0b',
            borderDash: [5, 4],
            tension: 0.3,
            spanGaps: true,
            pointRadius: 0,
          },
        ],
      },
      options: { scales: { y: { beginAtZero: true } } },
    };

    const gameName = req.game?.name ?? gameId;
    const games = await this.credentials.listGames();
    return {
      panelTitle: s.panelTitle,
      logoUrl: s.logoUrl,
      operator,
      games,
      nav: 'sessions',
      gameId,
      gameName,
      pageTitle: `${gameName} · Sessions`,
      breadcrumb: [
        { label: 'Games', href: '/panel/games' },
        { label: gameName, href: `/panel/${gameId}/settings` },
        { label: 'Sessions' },
      ],
      period: resolved.preset,
      summary: {
        totalSessions: fmtCount(totalSessions),
        avgDuration: fmtDuration(avgDurationMs),
      },
      provisional,
      countChart,
      dauChart,
      hasData: totalSessions > 0,
    };
  }
}
