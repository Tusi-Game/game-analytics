import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from '../http/authenticated-request';

/**
 * `@GameId()` — extracts the `game_id` resolved by `SdkKeyGuard` from the
 * request context. Returns `undefined` if no guard populated it.
 */
export const GameId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | undefined => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.game_id;
});
