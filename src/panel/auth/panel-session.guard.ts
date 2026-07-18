/**
 * PanelSessionGuard (T-11.20) — the SSR cookie-transport session check for all
 * `/panel/*` routes except login/MFA. It is a thin cookie wrapper over the REAL
 * bearer session store: it extracts the opaque session id from the panel cookie,
 * resolves it via the SAME {@link OperatorSessionService} the admin API uses
 * (never a second store), and stamps `request.operator` so the reused
 * {@link RolesGuard} + `@CurrentOperator` + `@Roles` all work unchanged.
 *
 * On a missing/expired session the panel needs a BROWSER redirect to
 * `/panel/login`, not a JSON 401 — a bare 401 would leave the operator on a blank
 * page. For a full navigation we 302 to the login page; for an HTMX request we
 * emit `HX-Redirect` (HTMX performs a client-side redirect on that header) so an
 * expired-session partial swap sends the operator to login rather than injecting
 * an error fragment.
 */

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { OperatorSessionService } from '../../operator/operator-session.service';
import type { OperatorRequest } from '../../operator/operator-request';
import { readPanelSessionCookie } from './panel-cookie';

@Injectable()
export class PanelSessionGuard implements CanActivate {
  constructor(private readonly sessions: OperatorSessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<OperatorRequest>();
    const response = http.getResponse<Response>();

    const sessionId = readPanelSessionCookie(request);
    const session = await this.sessions.resolve(sessionId);
    if (!session) {
      // Browser-native redirect to login (HTMX-aware).
      if (request.headers['hx-request'] === 'true') {
        response.setHeader('HX-Redirect', '/panel/login');
        response.status(401).send();
      } else {
        response.redirect(302, '/panel/login');
      }
      return false;
    }

    request.operator = session;
    return true;
  }
}
