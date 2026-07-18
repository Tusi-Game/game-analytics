import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { OperatorRequest } from './operator-request';
import type { OperatorSession } from './operator-session.service';

/**
 * @CurrentOperator() — inject the resolved {@link OperatorSession} into a handler
 * (stamped by OperatorSessionGuard). Throws if absent (guard misconfiguration),
 * so a handler never runs unauthenticated by accident.
 */
export const CurrentOperator = createParamDecorator((_data: unknown, ctx: ExecutionContext): OperatorSession => {
  const request = ctx.switchToHttp().getRequest<OperatorRequest>();
  if (!request.operator) {
    throw new UnauthorizedException('Operator session required');
  }
  return request.operator;
});
