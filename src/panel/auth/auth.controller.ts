/**
 * Panel auth controller (T-11.18/23/24) — SSR login / logout / MFA. It CONSUMES
 * the 011 control plane: login calls {@link OperatorAuthService.login} (which owns
 * password verify, lockout, MFA check, and session create) and writes the returned
 * opaque sessionId into the panel cookie (see panel-cookie.ts). It does NOT
 * reimplement any account semantics or introduce a second session store.
 *
 * These routes are UNGUARDED (an operator must reach them without a session). All
 * other `/panel/*` routes are behind {@link PanelSessionGuard}.
 */

import { Body, Controller, Get, Post, Query, Render, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { OperatorAuthService } from '../../operator/operator-auth.service';
import { OperatorSessionService } from '../../operator/operator-session.service';
import { PanelConfigService } from '../panel-config.service';
import {
  PANEL_SESSION_COOKIE,
  clearPanelSessionCookie,
  readPanelSessionCookie,
  setPanelSessionCookie,
} from './panel-cookie';

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

@Controller('panel')
export class AuthController {
  private readonly sessionTimeoutMin: number;

  constructor(
    private readonly auth: OperatorAuthService,
    private readonly sessions: OperatorSessionService,
    private readonly panelConfig: PanelConfigService,
    config: ConfigService,
  ) {
    this.sessionTimeoutMin = config.get<number>('OPERATOR_SESSION_TIMEOUT_MIN') ?? 120;
  }

  /** GET /panel/login — the login card. */
  @Get('login')
  @Render('auth/login')
  loginPage(@Query('error') error?: string): Record<string, unknown> {
    const s = this.panelConfig.settings();
    return {
      panelTitle: s.panelTitle,
      logoUrl: s.logoUrl,
      error: error === '1' ? 'Invalid email, password, or MFA code.' : '',
    };
  }

  /**
   * POST /panel/login — HTMX form submit. On success writes the session cookie and
   * asks HTMX to redirect to /panel/games (HX-Redirect). On failure swaps the form
   * back with an inline error (200 so HTMX renders the fragment).
   */
  @Post('login')
  @Render('auth/login')
  async login(
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const s = this.panelConfig.settings();
    const email = asString(body.email);
    const password = asString(body.password);
    const totpCode = asString(body.totpCode);
    const base = { panelTitle: s.panelTitle, logoUrl: s.logoUrl, email: email ?? '' };

    if (email === undefined || password === undefined) {
      return { ...base, error: 'Email and password are required.' };
    }
    try {
      const result = await this.auth.login({ email, password, totpCode, source: req.ip });
      setPanelSessionCookie(res, result.sessionId, s.cookieSecure, this.sessionTimeoutMin * 60);
      // HTMX performs a client-side redirect on this response header.
      res.setHeader('HX-Redirect', '/panel/games');
      return { ...base, redirected: true };
    } catch {
      // Generic message (the service intentionally does not leak which factor failed).
      return { ...base, error: 'Invalid email, password, or MFA code.' };
    }
  }

  /** POST /panel/logout — destroy the session + clear the cookie, then redirect. */
  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    const s = this.panelConfig.settings();
    const sessionId = readPanelSessionCookie(req);
    if (sessionId) {
      await this.auth.logout(sessionId);
    }
    clearPanelSessionCookie(res, s.cookieSecure);
    if (req.headers['hx-request'] === 'true') {
      res.setHeader('HX-Redirect', '/panel/login');
      res.status(200).send();
    } else {
      res.redirect(302, '/panel/login');
    }
  }

  /**
   * GET /panel/mfa — first-login MFA-required interstitial. In the synchronous 011
   * model MFA is verified inline at login (OperatorAuthService.login checks the
   * TOTP code), so this page explains that MFA enrolment is managed by an admin on
   * the operator account form (spec §2.10) and routes the operator back to login.
   * Persisted MFA enrolment lives in OperatorAdminService (blocker 2).
   */
  @Get('mfa')
  @Render('auth/mfa-setup')
  mfaPage(@Req() req: Request): Record<string, unknown> {
    const s = this.panelConfig.settings();
    // A session is optional here; if present we can show the operator email.
    const hasSession = readPanelSessionCookie(req).length > 0 || req.headers.cookie?.includes(PANEL_SESSION_COOKIE);
    return { panelTitle: s.panelTitle, logoUrl: s.logoUrl, hasSession: Boolean(hasSession) };
  }

  /** POST /panel/mfa/verify — resolve the current session (proves the code passed at login). */
  @Post('mfa/verify')
  async mfaVerify(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sessionId = readPanelSessionCookie(req);
    const session = await this.sessions.resolve(sessionId);
    if (!session) {
      throw new UnauthorizedException('No active session — log in again.');
    }
    if (req.headers['hx-request'] === 'true') {
      res.setHeader('HX-Redirect', '/panel/games');
      res.status(200).send();
    } else {
      res.redirect(302, '/panel/games');
    }
  }
}
