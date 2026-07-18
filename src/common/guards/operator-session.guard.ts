import { CanActivate, Injectable } from '@nestjs/common';

/**
 * Operator-session guard for panel routes (SKELETON — still return-true).
 *
 * 011 Unit A implemented the REAL operator-session guard in
 * `src/operator/operator-session.guard.ts` (Redis-backed, TTL). This common
 * skeleton is intentionally LEFT UNCHANGED in Unit A because it is currently
 * bound to the panel (012) + dashboard read-model (002) routes, which are not
 * migrated to real operator auth in this unit; flipping it to a real check here
 * would break those routes/tests before the panel consumes the real guard.
 *
 * RETIREMENT DECISION (for Unit C / 012): migrate the panel + dashboard routes to
 * `@UseGuards(operator/OperatorSessionGuard)` (importing OperatorModule) and
 * delete this skeleton. Tracked alongside the SdkKeyGuard retirement note.
 */
@Injectable()
export class OperatorSessionGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
