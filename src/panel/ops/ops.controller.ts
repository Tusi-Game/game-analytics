/**
 * Ops controller (T-11.73-78) — cold-storage status, exceptions pivot, and the
 * SYNCHRONOUS erasure/DSAR surface. Reads {@link UploadStatusReadModel},
 * {@link ExceptionReadService} (gated on `drop_counter_visible`), and drives
 * {@link GdprAdminService} inline (submit → immediate result; history = a read
 * over GDPR_REQUEST_AUDIT). There is NO async job queue / download-token layer in
 * the platform, so the 7-day-token async flow is intentionally out of scope
 * (research brief §9 blocker 3). Erasure/DSAR submit is admin-only.
 */

import { Body, Controller, Get, Param, Post, Query, Render, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { UploadStatusReadModel } from '../../cold-storage/upload-status.read-model';
import { ExceptionReadService } from '../../dashboard/exception-read.service';
import { GdprAdminService } from '../../operator/gdpr-admin.service';
import { GameConfigService, GAME_CONFIG_DEFAULTS } from '../../config/game-config.service';
import { PanelConfigService } from '../panel-config.service';
import { CredentialService } from '../../operator/credential.service';
import { Roles } from '../../operator/roles.decorator';
import { RolesGuard } from '../../operator/roles.guard';
import { CurrentOperator } from '../../operator/current-operator.decorator';
import type { OperatorSession } from '../../operator/operator-session.service';
import { PanelSessionGuard } from '../auth/panel-session.guard';
import { GameAccessGuard, type GameScopedRequest } from '../auth/game-access.guard';
import { resolvePeriod, enumeratePeriodDays } from '../dashboard/period';

@Controller('panel')
@UseGuards(PanelSessionGuard)
export class OpsController {
  constructor(
    private readonly uploads: UploadStatusReadModel,
    private readonly exceptions: ExceptionReadService,
    private readonly gdpr: GdprAdminService,
    private readonly gameConfig: GameConfigService,
    private readonly panelConfig: PanelConfigService,
    private readonly credentials: CredentialService,
  ) {}

  private async chrome(
    operator: OperatorSession,
    gameId: string,
    req: GameScopedRequest,
  ): Promise<Record<string, unknown>> {
    const s = this.panelConfig.settings();
    const games = await this.credentials.listGames();
    const gameName = req.game?.name ?? gameId;
    return { panelTitle: s.panelTitle, logoUrl: s.logoUrl, operator, games, gameId, gameName };
  }

  // ── Cold storage ────────────────────────────────────────────────────────────

  @Get(':gameId/ops/cold-storage')
  @UseGuards(GameAccessGuard)
  @Render('ops/cold-storage')
  async coldStorage(
    @CurrentOperator() operator: OperatorSession,
    @Param('gameId') gameId: string,
    @Req() req: GameScopedRequest,
  ): Promise<Record<string, unknown>> {
    const chrome = await this.chrome(operator, gameId, req);
    const [rows, enabled, bucket, schedule] = await Promise.all([
      this.uploads.recordedFor(gameId),
      this.gameConfig.getBoolean(gameId, 'cold_storage_enabled'),
      this.gameConfig.getString(gameId, 'cold_storage_bucket'),
      this.gameConfig.getString(gameId, 'cold_storage_upload_schedule'),
    ]);
    return {
      ...chrome,
      nav: 'ops-cold',
      pageTitle: `${chrome.gameName} · Cold storage`,
      breadcrumb: [
        { label: 'Games', href: '/panel/games' },
        { label: chrome.gameName, href: `/panel/${gameId}/settings` },
        { label: 'Cold storage' },
      ],
      enabled: enabled ?? GAME_CONFIG_DEFAULTS.cold_storage_enabled,
      bucket: bucket ?? '(not set)',
      schedule: schedule ?? '(default)',
      rows: rows.slice().reverse(),
    };
  }

  // ── Exceptions (gated on drop_counter_visible) ──────────────────────────────

  @Get(':gameId/ops/exceptions')
  @UseGuards(GameAccessGuard)
  @Render('ops/exceptions')
  async exceptionsView(
    @CurrentOperator() operator: OperatorSession,
    @Param('gameId') gameId: string,
    @Query('period') period: string | undefined,
    @Req() req: GameScopedRequest,
  ): Promise<Record<string, unknown>> {
    const chrome = await this.chrome(operator, gameId, req);
    const visible =
      (await this.gameConfig.getBoolean(gameId, 'drop_counter_visible')) ?? GAME_CONFIG_DEFAULTS.drop_counter_visible;
    const resolved = resolvePeriod(period, undefined, undefined);

    let reasons: readonly string[] = [];
    let rows: Array<{ day: string; counts: Record<string, number>; total: number; provisional: boolean }> = [];
    let maxCell = 0;
    let total = 0;
    if (visible) {
      reasons = this.exceptions.reasons();
      const days = enumeratePeriodDays(resolved.from, resolved.to);
      for (const day of days) {
        const view = await this.exceptions.exceptionDay(gameId, day);
        const counts: Record<string, number> = {};
        for (const r of reasons) {
          const c = view.perReason[r as keyof typeof view.perReason] ?? 0;
          counts[r] = c;
          if (c > maxCell) {
            maxCell = c;
          }
        }
        total += view.total;
        rows.push({ day, counts, total: view.total, provisional: view.provisional });
      }
      rows = rows.reverse();
    }

    return {
      ...chrome,
      nav: 'ops-exc',
      pageTitle: `${chrome.gameName} · Exceptions`,
      breadcrumb: [
        { label: 'Games', href: '/panel/games' },
        { label: chrome.gameName, href: `/panel/${gameId}/settings` },
        { label: 'Exceptions' },
      ],
      visible,
      period: resolved.preset,
      reasons,
      rows,
      maxCell,
      total,
    };
  }

  // ── Erasure / DSAR (synchronous model) ──────────────────────────────────────

  @Get(':gameId/ops/erasure')
  @UseGuards(GameAccessGuard)
  @Render('ops/erasure')
  async erasureView(
    @CurrentOperator() operator: OperatorSession,
    @Param('gameId') gameId: string,
    @Req() req: GameScopedRequest,
    @Query('flash') flash?: string,
  ): Promise<Record<string, unknown>> {
    const chrome = await this.chrome(operator, gameId, req);
    const [erasureHistory, dsarHistory] = await Promise.all([
      this.gdpr.listGdprAudit(gameId, 'erasure'),
      this.gdpr.listGdprAudit(gameId, 'dsar_access'),
    ]);
    return {
      ...chrome,
      nav: 'ops-erasure',
      pageTitle: `${chrome.gameName} · Erasure / DSAR`,
      breadcrumb: [
        { label: 'Games', href: '/panel/games' },
        { label: chrome.gameName, href: `/panel/${gameId}/settings` },
        { label: 'Erasure / DSAR' },
      ],
      canSubmit: operator.role === 'admin',
      erasureHistory,
      dsarHistory,
      flash: flashFromQuery(flash),
    };
  }

  @Post(':gameId/ops/erasure')
  @UseGuards(GameAccessGuard, RolesGuard)
  @Roles('admin')
  async submitErasure(
    @CurrentOperator() operator: OperatorSession,
    @Param('gameId') gameId: string,
    @Body() body: Record<string, unknown>,
    @Req() req: GameScopedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    const attestation = typeof body.attestation === 'string' ? body.attestation.trim() : '';
    if (userId === '' || attestation === '') {
      redirect(res, req, `/panel/${gameId}/ops/erasure?flash=error:User+ID+and+verification+are+required`);
      return;
    }
    try {
      const result = await this.gdpr.triggerErasure({ gameId, userId, attestation, operatorId: operator.operatorId });
      redirect(
        res,
        req,
        `/panel/${gameId}/ops/erasure?flash=success:Erasure+submitted+(${encodeURIComponent(result.status)})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'erasure failed';
      redirect(res, req, `/panel/${gameId}/ops/erasure?flash=error:${encodeURIComponent(msg)}`);
    }
  }

  @Post(':gameId/ops/dsar')
  @UseGuards(GameAccessGuard, RolesGuard)
  @Roles('admin')
  async submitDsar(
    @CurrentOperator() operator: OperatorSession,
    @Param('gameId') gameId: string,
    @Body() body: Record<string, unknown>,
    @Req() req: GameScopedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    const attestation = typeof body.attestation === 'string' ? body.attestation.trim() : '';
    if (userId === '' || attestation === '') {
      redirect(res, req, `/panel/${gameId}/ops/erasure?flash=error:User+ID+and+verification+are+required`);
      return;
    }
    try {
      await this.gdpr.triggerDsar({ gameId, userId, attestation, operatorId: operator.operatorId });
      redirect(res, req, `/panel/${gameId}/ops/erasure?flash=success:Access+export+assembled+—+see+history`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'DSAR failed';
      redirect(res, req, `/panel/${gameId}/ops/erasure?flash=error:${encodeURIComponent(msg)}`);
    }
  }
}

function redirect(res: Response, req: GameScopedRequest, to: string): void {
  if (req.headers['hx-request'] === 'true') {
    res.setHeader('HX-Redirect', to);
    res.status(200).send();
  } else {
    res.redirect(302, to);
  }
}

function flashFromQuery(flash: string | undefined): { type: string; message: string } | null {
  if (!flash) {
    return null;
  }
  const idx = flash.indexOf(':');
  return idx === -1 ? { type: 'info', message: flash } : { type: flash.slice(0, idx), message: flash.slice(idx + 1) };
}
