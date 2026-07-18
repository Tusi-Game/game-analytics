/**
 * Panel cookie transport (spec §3.1) — the SSR cookie layer over the SAME opaque
 * bearer session the 011 control plane issues. The panel does NOT introduce a
 * second session store: login calls {@link OperatorAuthService.login}, then this
 * helper writes the returned `sessionId` into an `HttpOnly; SameSite=Lax` cookie
 * (Secure when TLS is on), and the panel guard reads the sessionId back from that
 * cookie and resolves it via the SAME {@link OperatorSessionService}.
 *
 * A browser cannot inject an `Authorization: Bearer` header on plain navigations
 * or HTMX swaps, so the bearer transport used by the admin API is unusable for
 * the panel; the cookie is the browser-native equivalent. The value is the same
 * opaque id — revocable server-side, TTL-bounded in Redis.
 */

import type { Request, Response } from 'express';

/** The cookie name carrying the opaque operator session id for the panel. */
export const PANEL_SESSION_COOKIE = 'panel_session';

/**
 * Read the panel session id from the request cookie header. `cookie-parser` is
 * NOT installed (keep the surface minimal), so this parses the raw `Cookie`
 * header directly. Returns '' when absent.
 */
export function readPanelSessionCookie(req: Request): string {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length === 0) {
    return '';
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (name === PANEL_SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return '';
}

/**
 * Write the panel session cookie: `HttpOnly` (no JS access — XSS-hardened),
 * `SameSite=Lax` (survives top-level navigation, blocks cross-site POST CSRF),
 * `Path=/`, and `Secure` when TLS is on (config). `maxAgeSec` mirrors the session
 * idle timeout so the cookie and the Redis session expire together.
 */
export function setPanelSessionCookie(res: Response, sessionId: string, secure: boolean, maxAgeSec: number): void {
  const attrs = [
    `${PANEL_SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.max(1, Math.floor(maxAgeSec))}`,
  ];
  if (secure) {
    attrs.push('Secure');
  }
  res.setHeader('Set-Cookie', attrs.join('; '));
}

/** Clear the panel session cookie (logout). */
export function clearPanelSessionCookie(res: Response, secure: boolean): void {
  const attrs = [`${PANEL_SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (secure) {
    attrs.push('Secure');
  }
  res.setHeader('Set-Cookie', attrs.join('; '));
}
