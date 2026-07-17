import { CanActivate, Injectable } from '@nestjs/common';

/**
 * Operator-session guard for panel routes (SKELETON — spec 011 implements it).
 *
 * No-op in this scaffold: always returns `true`. Spec 011 replaces this with a
 * real session check (cookie / session store) for operator-facing panel routes.
 */
@Injectable()
export class OperatorSessionGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
