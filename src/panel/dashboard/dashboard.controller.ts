/**
 * Panel dashboard controller (T-11.38-43) — GET /panel/:gameId, the per-game
 * overview. Delegates the 8-card KPI row + event chart + top events + exceptions
 * to {@link DashboardService} (which consumes the read services' §3.3 merge). The
 * period selector drives `?period=` swaps.
 */

import { Controller, Get, Param, Query, Render, Req, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { PanelConfigService } from '../panel-config.service';
import { CredentialService } from '../../operator/credential.service';
import { GameConfigService, GAME_CONFIG_DEFAULTS } from '../../config/game-config.service';
import { CurrentOperator } from '../../operator/current-operator.decorator';
import type { OperatorSession } from '../../operator/operator-session.service';
import { PanelSessionGuard } from '../auth/panel-session.guard';
import { GameAccessGuard, type GameScopedRequest } from '../auth/game-access.guard';
import { resolvePeriod } from './period';

@Controller('panel')
@UseGuards(PanelSessionGuard)
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly panelConfig: PanelConfigService,
    private readonly credentials: CredentialService,
    private readonly gameConfig: GameConfigService,
  ) {}

  @Get(':gameId')
  @UseGuards(GameAccessGuard)
  @Render('dashboard/index')
  async index(
    @CurrentOperator() operator: OperatorSession,
    @Param('gameId') gameId: string,
    @Query('period') period: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() req: GameScopedRequest,
  ): Promise<Record<string, unknown>> {
    const s = this.panelConfig.settings();
    const resolved = resolvePeriod(period, from, to);
    const topN = (await this.gameConfig.getNumber(gameId, 'top_n_events')) ?? GAME_CONFIG_DEFAULTS.top_n_events;
    const [games, overview] = await Promise.all([
      this.credentials.listGames(),
      this.dashboard.overview(gameId, resolved, topN, s.chartColorPrimary),
    ]);
    const gameName = req.game?.name ?? gameId;

    return {
      panelTitle: s.panelTitle,
      logoUrl: s.logoUrl,
      livePollSec: s.livePollIntervalSec,
      operator,
      games,
      nav: 'dashboard',
      gameId,
      gameName,
      pageTitle: `${gameName} · Dashboard`,
      breadcrumb: [
        { label: 'Games', href: '/panel/games' },
        { label: gameName, href: `/panel/${gameId}/settings` },
        { label: 'Dashboard' },
      ],
      period: resolved.preset,
      cards: overview.cards,
      eventChart: overview.eventChart,
      topEvents: overview.topEvents,
      exceptions: overview.exceptions,
    };
  }
}
