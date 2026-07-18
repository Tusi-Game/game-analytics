import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest, Provenance as ProvenanceValue } from '../http/authenticated-request';

/**
 * `@Provenance()` — extracts the SERVER-DERIVED request provenance
 * (`'client' | 'server'`) stamped by the ingest credential guard
 * (`IngestAuthGuard`) onto the request. Returns `undefined` if no guard
 * populated it.
 */
export const Provenance = createParamDecorator((_data: unknown, ctx: ExecutionContext): ProvenanceValue | undefined => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  return request.provenance;
});
