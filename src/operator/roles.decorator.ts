import { SetMetadata } from '@nestjs/common';
import type { OperatorRole } from '../database/entities/operator-account.entity';

/** Metadata key the RolesGuard reads. */
export const ROLES_KEY = 'operator_roles';

/**
 * @Roles(...) — declare the operator role(s) allowed to invoke a route (T-10.11).
 * A `viewer` may READ; only `admin` may write config / touch credentials. A route
 * with no @Roles is readable by any authenticated operator (viewer or admin).
 */
export const Roles = (...roles: OperatorRole[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);
