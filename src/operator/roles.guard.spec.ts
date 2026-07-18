import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import type { OperatorRole } from '../database/entities/operator-account.entity';

/**
 * RBAC enforcement (T-10.11/T-10.39). Proves: a viewer is refused an @Roles(admin)
 * route; an admin is allowed; a route with no @Roles is open to any authenticated
 * operator.
 */

function context(role: OperatorRole | undefined): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ operator: role ? { role } : undefined }) }),
  } as unknown as ExecutionContext;
}

function reflector(required: OperatorRole[] | undefined): Reflector {
  return { getAllAndOverride: () => required } as unknown as Reflector;
}

describe('RolesGuard', () => {
  it('viewer is refused an admin-only route', () => {
    const guard = new RolesGuard(reflector(['admin']));
    expect(() => guard.canActivate(context('viewer'))).toThrow(ForbiddenException);
  });

  it('admin is allowed an admin-only route', () => {
    const guard = new RolesGuard(reflector(['admin']));
    expect(guard.canActivate(context('admin'))).toBe(true);
  });

  it('a route with no @Roles is open to any authenticated operator (viewer ok)', () => {
    const guard = new RolesGuard(reflector(undefined));
    expect(guard.canActivate(context('viewer'))).toBe(true);
  });

  it('an unauthenticated request is refused an admin-only route', () => {
    const guard = new RolesGuard(reflector(['admin']));
    expect(() => guard.canActivate(context(undefined))).toThrow(ForbiddenException);
  });
});
