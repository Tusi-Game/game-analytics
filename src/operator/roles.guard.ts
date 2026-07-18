/**
 * RolesGuard (T-10.11) — enforces the `viewer`/`admin` split. Reads the required
 * roles declared by @Roles on the handler/class and the resolved
 * `request.operator.role` (stamped by OperatorSessionGuard, which MUST run
 * first). A `viewer` is refused every @Roles('admin') route (config writes +
 * credential ops); `admin` is allowed both. No @Roles ⇒ any authenticated
 * operator (read-only surfaces).
 */

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import type { OperatorRole } from '../database/entities/operator-account.entity';
import type { OperatorRequest } from './operator-request';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<OperatorRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true; // no role constraint — any authenticated operator.
    }
    const request = context.switchToHttp().getRequest<OperatorRequest>();
    const role = request.operator?.role;
    if (role === undefined || !required.includes(role)) {
      throw new ForbiddenException('Insufficient operator role');
    }
    return true;
  }
}
