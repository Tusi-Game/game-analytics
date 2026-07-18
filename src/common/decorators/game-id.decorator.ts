import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from '../http/authenticated-request';

/**
 * `@GameId()` — extracts the SERVER-DERIVED `game_id` stamped by the ingest
 * credential guard (`IngestAuthGuard`) onto the request. Returns `undefined` if
 * no guard populated it.
 */
export const GameId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | undefined => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.game_id;
});
