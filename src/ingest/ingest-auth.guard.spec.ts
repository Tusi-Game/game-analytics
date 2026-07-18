/**
 * Ingest auth guard — TLS + Origin posture (T-00.85 / T-00.87, FR-029).
 *
 * Proves: plain-HTTP bearer auth is refused (403) when REQUIRE_TLS=true and no
 * X-Forwarded-Proto: https; a TLS request (proxy header) is admitted; an Origin
 * outside ALLOWED_ORIGINS is refused; server-to-server (no Origin) is unaffected;
 * a good credential over TLS stamps the server-derived scope.
 */

import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IngestAuthGuard } from './ingest-auth.guard';
import type { CredentialResolver } from './credential-resolver.service';

function cfg(values: Record<string, unknown>): ConfigService {
  return { get: <T>(k: string): T => values[k] as T } as unknown as ConfigService;
}

function resolver(scope: { gameId: string; provenance: 'client' | 'server' } | null): CredentialResolver {
  return { resolve: async () => scope } as unknown as CredentialResolver;
}

function ctx(
  headers: Record<string, unknown>,
  secure = false,
): { context: ExecutionContext; req: Record<string, unknown> } {
  const req: Record<string, unknown> = { headers, secure };
  const context = {
    switchToHttp: () => ({ getRequest: <T>(): T => req as T }),
  } as unknown as ExecutionContext;
  return { context, req };
}

describe('IngestAuthGuard TLS refusal', () => {
  it('403s plain-HTTP bearer auth when REQUIRE_TLS=true', async () => {
    const guard = new IngestAuthGuard(resolver({ gameId: 'g1', provenance: 'client' }), cfg({ REQUIRE_TLS: true }));
    const { context } = ctx({ authorization: 'Bearer k' }); // no x-forwarded-proto, not secure
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('admits a request forwarded as https by the proxy', async () => {
    const guard = new IngestAuthGuard(resolver({ gameId: 'g1', provenance: 'client' }), cfg({ REQUIRE_TLS: true }));
    const { context, req } = ctx({ authorization: 'Bearer k', 'x-forwarded-proto': 'https' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req['game_id']).toBe('g1');
    expect(req['provenance']).toBe('client');
  });

  it('does not require TLS when REQUIRE_TLS=false (dev)', async () => {
    const guard = new IngestAuthGuard(resolver({ gameId: 'g1', provenance: 'server' }), cfg({ REQUIRE_TLS: false }));
    const { context } = ctx({ authorization: 'Bearer k' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});

describe('IngestAuthGuard Origin check', () => {
  it('403s an Origin outside the allow-list', async () => {
    const guard = new IngestAuthGuard(
      resolver({ gameId: 'g1', provenance: 'client' }),
      cfg({ REQUIRE_TLS: false, ALLOWED_ORIGINS: 'https://good.example' }),
    );
    const { context } = ctx({ authorization: 'Bearer k', origin: 'https://evil.example' });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('admits an allowed Origin', async () => {
    const guard = new IngestAuthGuard(
      resolver({ gameId: 'g1', provenance: 'client' }),
      cfg({ REQUIRE_TLS: false, ALLOWED_ORIGINS: 'https://good.example' }),
    );
    const { context } = ctx({ authorization: 'Bearer k', origin: 'https://good.example' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('ignores the Origin check for server-to-server callers (no Origin header)', async () => {
    const guard = new IngestAuthGuard(
      resolver({ gameId: 'g1', provenance: 'server' }),
      cfg({ REQUIRE_TLS: false, ALLOWED_ORIGINS: 'https://good.example' }),
    );
    const { context } = ctx({ authorization: 'Bearer k' }); // no origin
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});

describe('IngestAuthGuard credential', () => {
  it('401s an unknown credential (nothing recorded)', async () => {
    const guard = new IngestAuthGuard(resolver(null), cfg({ REQUIRE_TLS: false }));
    const { context } = ctx({ authorization: 'Bearer nope' });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
