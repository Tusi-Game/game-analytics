import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest, Provenance as ProvenanceValue } from '../http/authenticated-request';

/**
 * `@Provenance()` — extracts the request provenance (`'client' | 'server'`)
 * resolved by `SdkKeyGuard` from the request context. Returns `undefined` if no
 * guard populated it.
 */
export const Provenance = createParamDecorator((_data: unknown, ctx: ExecutionContext): ProvenanceValue | undefined => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.provenance;
});
