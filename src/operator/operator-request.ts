import type { Request } from 'express';
import type { OperatorSession } from './operator-session.service';

/**
 * Express request augmented by {@link OperatorSessionGuard} with the resolved
 * operator session. Distinct from the ingest `AuthenticatedRequest` (game-scoped
 * credential auth) — this is STAFF (cross-game) session auth. RolesGuard reads
 * `request.operator.role`; per-game scoping of writes/views is enforced in the
 * controllers/services (P12), not here.
 */
export interface OperatorRequest extends Request {
  operator?: OperatorSession;
}

/** Header the client presents its opaque session id in (bearer form). */
export const OPERATOR_SESSION_HEADER = 'authorization';

/** Extract the opaque session id from an operator request's bearer header. */
export function extractSessionId(req: OperatorRequest): string {
  const header = req.headers[OPERATOR_SESSION_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') {
    return '';
  }
  return value.startsWith('Bearer ') ? value.slice(7).trim() : value.trim();
}
