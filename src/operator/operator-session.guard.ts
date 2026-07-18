/**
 * OperatorSessionGuard (T-10.7) — the REAL operator-session check for admin
 * routes. Resolves the opaque session id from `Authorization: Bearer <id>`
 * against the Redis session store and stamps `request.operator` for RolesGuard +
 * controllers. Unknown/expired session → 401.
 *
 * Built in operator/ (not the common/ skeleton) because it must inject
 * OperatorSessionService. The common/guards/operator-session.guard.ts skeleton
 * (return-true) is now DEAD — nothing binds it; it is left for retirement in a
 * later unit (see the module JSDoc + the SdkKeyGuard note).
 */

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { OperatorSessionService } from './operator-session.service';
import { extractSessionId, type OperatorRequest } from './operator-request';

@Injectable()
export class OperatorSessionGuard implements CanActivate {
  constructor(private readonly sessions: OperatorSessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<OperatorRequest>();
    const sessionId = extractSessionId(request);
    const session = await this.sessions.resolve(sessionId);
    if (!session) {
      throw new UnauthorizedException('Operator session required');
    }
    request.operator = session;
    return true;
  }
}
