/**
 * Games controller (T-11.32-37) — game list, per-game hub (SDK keys + server
 * credentials + quick stats + retire), and the one-time credential-show page. All
 * writes go through the 011 {@link CredentialService} (the sole GAME/credential
 * writer, P9); the panel never writes those tables directly.
 *
 * Show-once (R8/P13): a freshly minted credential's raw value is rendered EXACTLY
 * once. On mint we set a 5-min `panel:*` Redis flag and stash the raw value in a
 * short-lived in-process map keyed by the flag; the show page consumes both (the
 * raw is never stored in the session and never re-derivable — only *_hash/*_prefix
 * persist). Absent flag → redirect to the game hub with a flash.
 */

import { Controller, Delete, Get, Inject, Param, Post, Query, Render, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { PANEL_CREDENTIAL_SHOW_TTL_SECONDS, PanelKeys } from '../../common/redis-keys/redis-keys';
import { CredentialService, type IssuedCredential } from '../../operator/credential.service';
import { MonetizationReadService } from '../../monetization/monetization-read.service';
import { Roles } from '../../operator/roles.decorator';
import { RolesGuard } from '../../operator/roles.guard';
import { CurrentOperator } from '../../operator/current-operator.decorator';
import type { OperatorSession } from '../../operator/operator-session.service';
import { PanelSessionGuard } from '../auth/panel-session.guard';
import { GameAccessGuard, type GameScopedRequest } from '../auth/game-access.guard';
import { PanelConfigService } from '../panel-config.service';
import { utcDay } from '../../common/kernel/logical-day';
import { fmtCount } from '../view-model';

/** One entry of the short-lived raw-credential stash (paired with the Redis flag). */
interface RawStash {
  raw: string;
  prefix: string;
  gameId: string;
  expiresAt: number;
}

@Controller('panel')
@UseGuards(PanelSessionGuard)
export class GamesController {
  /**
   * In-process raw-credential stash for the show-once page — keyed by
   * `{credentialId}:{operatorId}`. The RAW value lives here only for the 5-min TTL
   * window and is deleted on view; a browser back-button hits the Redis flag guard
   * and finds it gone. This is NOT a durable store (losing it just means the
   * operator re-issues the credential).
   */
  private readonly rawStash = new Map<string, RawStash>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly credentials: CredentialService,
    private readonly monetization: MonetizationReadService,
    private readonly panelConfig: PanelConfigService,
  ) {}

  private async baseCtx(operator: OperatorSession): Promise<Record<string, unknown>> {
    const s = this.panelConfig.settings();
    const games = await this.credentials.listGames();
    return {
      panelTitle: s.panelTitle,
      logoUrl: s.logoUrl,
      livePollSec: s.livePollIntervalSec,
      operator,
      games,
    };
  }

  // ── Game list (login landing) ──────────────────────────────────────────────

  @Get('games')
  @Render('games/list')
  async list(
    @CurrentOperator() operator: OperatorSession,
    @Query('flash') flash?: string,
  ): Promise<Record<string, unknown>> {
    const ctx = await this.baseCtx(operator);
    const today = utcDay(Date.now());
    // Live daily-events badge per game (current-day, provisional) is polled by the
    // template via /panel/:gameId/quickstats; here we just list the games.
    return {
      ...ctx,
      nav: 'games',
      pageTitle: 'Games',
      breadcrumb: [{ label: 'Games' }],
      today,
      flash: flashFromQuery(flash),
    };
  }

  @Post('games')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async register(
    @CurrentOperator() operator: OperatorSession,
    @Req() req: GameScopedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const gameId = typeof body.gameId === 'string' && body.gameId.trim() !== '' ? body.gameId.trim() : slugify(name);
    if (name === '' || gameId === '') {
      redirect(res, req, '/panel/games?flash=error:Game+name+is+required');
      return;
    }
    try {
      const reg = await this.credentials.registerGame(gameId, name);
      this.stashRaw(reg.sdkKey, operator.operatorId);
      redirect(res, req, `/panel/${gameId}/credential/${reg.sdkKey.id}?kind=sdk_key`);
    } catch {
      redirect(res, req, '/panel/games?flash=error:Could+not+register+game+(id+may+already+exist)');
    }
  }

  // ── Game hub (settings / keys / credentials / quick stats) ──────────────────

  @Get(':gameId/settings')
  @UseGuards(GameAccessGuard)
  @Render('games/detail')
  async detail(
    @CurrentOperator() operator: OperatorSession,
    @Param('gameId') gameId: string,
    @Req() req: GameScopedRequest,
    @Query('flash') flash?: string,
  ): Promise<Record<string, unknown>> {
    const ctx = await this.baseCtx(operator);
    const [sdkKeys, serverCreds] = await Promise.all([
      this.credentials.listSdkKeys(gameId),
      this.credentials.listServerCredentials(gameId),
    ]);
    const retired = sdkKeys.length > 0 && sdkKeys.every((k) => k.revokedAt !== null);
    return {
      ...ctx,
      nav: 'settings',
      gameId,
      gameName: req.game?.name ?? gameId,
      pageTitle: `${req.game?.name ?? gameId} · Settings`,
      breadcrumb: [{ label: 'Games', href: '/panel/games' }, { label: req.game?.name ?? gameId }],
      sdkKeys,
      serverCreds,
      retired,
      canWrite: operator.role === 'admin',
      flash: flashFromQuery(flash),
    };
  }

  /** Quick-stats fragment for the hub (HTMX-polled). Returns a partial. */
  @Get(':gameId/quickstats')
  @UseGuards(GameAccessGuard)
  @Render('games/quick-stats')
  async quickStats(@Param('gameId') gameId: string): Promise<Record<string, unknown>> {
    const day = utcDay(Date.now());
    const active = await this.monetization.activeUsers(gameId, day);
    return {
      gameId,
      dau: fmtCount(active.dau),
      mau: fmtCount(active.mau),
      provisional: active.provisional,
    };
  }

  // ── sdk_key lifecycle ───────────────────────────────────────────────────────

  @Post(':gameId/sdk-keys')
  @UseGuards(GameAccessGuard, RolesGuard)
  @Roles('admin')
  async rotateSdkKey(
    @CurrentOperator() operator: OperatorSession,
    @Param('gameId') gameId: string,
    @Req() req: GameScopedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const issued = await this.credentials.issueSdkKey(gameId);
    this.stashRaw(issued, operator.operatorId);
    redirect(res, req, `/panel/${gameId}/credential/${issued.id}?kind=sdk_key`);
  }

  @Delete(':gameId/sdk-keys/:keyId')
  @UseGuards(GameAccessGuard, RolesGuard)
  @Roles('admin')
  async revokeSdkKey(
    @Param('gameId') gameId: string,
    @Param('keyId') keyId: string,
    @Req() req: GameScopedRequest,
    @Res() res: Response,
  ): Promise<void> {
    await this.credentials.revokeSdkKey(gameId, keyId, true);
    redirect(res, req, `/panel/${gameId}/settings?flash=success:SDK+key+revoked`);
  }

  // ── server_credential lifecycle ─────────────────────────────────────────────

  @Post(':gameId/server-credentials')
  @UseGuards(GameAccessGuard, RolesGuard)
  @Roles('admin')
  async createServerCredential(
    @CurrentOperator() operator: OperatorSession,
    @Param('gameId') gameId: string,
    @Req() req: GameScopedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const issued = await this.credentials.createServerCredential(gameId);
    this.stashRaw(issued, operator.operatorId);
    redirect(res, req, `/panel/${gameId}/credential/${issued.id}?kind=server_credential`);
  }

  @Delete(':gameId/server-credentials/:credentialId')
  @UseGuards(GameAccessGuard, RolesGuard)
  @Roles('admin')
  async revokeServerCredential(
    @Param('gameId') gameId: string,
    @Param('credentialId') credentialId: string,
    @Req() req: GameScopedRequest,
    @Res() res: Response,
  ): Promise<void> {
    await this.credentials.revokeServerCredential(gameId, credentialId);
    redirect(res, req, `/panel/${gameId}/settings?flash=success:Server+credential+revoked`);
  }

  // ── Retire ──────────────────────────────────────────────────────────────────

  @Post(':gameId/settings/retire')
  @UseGuards(GameAccessGuard, RolesGuard)
  @Roles('admin')
  async retire(@Param('gameId') gameId: string, @Req() req: GameScopedRequest, @Res() res: Response): Promise<void> {
    await this.credentials.retireGame(gameId);
    redirect(res, req, `/panel/${gameId}/settings?flash=warning:Game+retired+—+ingestion+stopped,+data+preserved`);
  }

  // ── Credential show-once ─────────────────────────────────────────────────────

  @Get(':gameId/credential/:credentialId')
  @UseGuards(GameAccessGuard)
  async showCredential(
    @CurrentOperator() operator: OperatorSession,
    @Param('gameId') gameId: string,
    @Param('credentialId') credentialId: string,
    @Query('kind') kind: string,
    @Res() res: Response,
  ): Promise<void> {
    const flagKey = PanelKeys.credentialShow(credentialId, operator.operatorId);
    const stashKey = `${credentialId}:${operator.operatorId}`;
    const flag = await this.redis.get(flagKey);
    const stash = this.rawStash.get(stashKey);

    if (flag === null || !stash || stash.gameId !== gameId || stash.expiresAt < Date.now()) {
      this.rawStash.delete(stashKey);
      await this.redis.del(flagKey);
      res.redirect(302, `/panel/${gameId}/settings?flash=warning:Credential+no+longer+available`);
      return;
    }

    // Consume the flag + stash so a refresh / back-button cannot re-show it.
    await this.redis.del(flagKey);
    this.rawStash.delete(stashKey);

    const s = this.panelConfig.settings();
    const games = await this.credentials.listGames();
    res.render('games/credential-show', {
      panelTitle: s.panelTitle,
      logoUrl: s.logoUrl,
      operator,
      games,
      nav: 'settings',
      gameId,
      pageTitle: 'New credential',
      breadcrumb: [
        { label: 'Games', href: '/panel/games' },
        { label: gameId, href: `/panel/${gameId}/settings` },
        { label: 'Credential' },
      ],
      kindLabel: kind === 'server_credential' ? 'Server credential' : 'SDK key',
      prefix: stash.prefix,
      raw: stash.raw,
    });
  }

  /**
   * Stash a freshly minted credential's raw value + set the 5-min show-once Redis
   * flag. The raw is held in-process only for the TTL window (never persisted).
   */
  private stashRaw(issued: IssuedCredential, operatorId: string): void {
    const stashKey = `${issued.id}:${operatorId}`;
    this.rawStash.set(stashKey, {
      raw: issued.raw,
      prefix: issued.prefix,
      gameId: issued.gameId,
      expiresAt: Date.now() + PANEL_CREDENTIAL_SHOW_TTL_SECONDS * 1000,
    });
    // Fire-and-forget the flag write (TTL-bounded, panel:* namespace, R8).
    void this.redis.set(PanelKeys.credentialShow(issued.id, operatorId), '1', 'EX', PANEL_CREDENTIAL_SHOW_TTL_SECONDS);
  }
}

/** Redirect helper that plays nice with HTMX (HX-Redirect) and full nav. */
function redirect(res: Response, req: GameScopedRequest, to: string): void {
  if (req.headers['hx-request'] === 'true') {
    res.setHeader('HX-Redirect', to);
    res.status(200).send();
  } else {
    res.redirect(302, to);
  }
}

/** Parse a `flash=type:message` query into a flash object. */
function flashFromQuery(flash: string | undefined): { type: string; message: string } | null {
  if (!flash) {
    return null;
  }
  const idx = flash.indexOf(':');
  if (idx === -1) {
    return { type: 'info', message: flash };
  }
  return { type: flash.slice(0, idx), message: flash.slice(idx + 1) };
}

/** Slugify a game name into a candidate game id (lowercase, dash-separated). */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
