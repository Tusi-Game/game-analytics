/**
 * Ingest auth guard (T-01.17, FR-003) — the real credential→game resolver bound
 * on `POST /v1/events`. It is the sole credential-authed route, so the old common
 * dev-skeleton `SdkKeyGuard` was retired in 011 Unit B; this guard is the
 * concrete ingest-path auth.
 *
 *   - Reads `Authorization: Bearer <credential>`.
 *   - Resolves `{ game_id, provenance }` server-side from the credential CLASS
 *     via {@link CredentialResolver} (never from the body — P12/P5, DARK-SPOT #9).
 *   - Unknown / revoked / missing credential → 401, NOTHING recorded (the request
 *     never reaches the controller, so no enqueue, no raw append, no DB write).
 *
 * On success it stamps `request.game_id` + `request.provenance` so the controller
 * and the `@GameId()` / `@Provenance()` decorators read the SERVER-DERIVED scope.
 */

import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedRequest } from '../common/http/authenticated-request';
import { CredentialResolver } from './credential-resolver.service';

/**
 * TLS + Origin posture (T-00.85/T-00.87, FR-029, ops-envelope §9).
 *
 * SINGLE-VPS posture (implemented consistently with the reference reverse proxy
 * in docker-compose): the reverse proxy TERMINATES TLS and forwards
 * `X-Forwarded-Proto: https`. The app binds behind the proxy and, when
 * `REQUIRE_TLS=true`, REFUSES plain-HTTP bearer auth — a request that did not
 * arrive over TLS (no `X-Forwarded-Proto: https`, and not a direct TLS socket)
 * is 403'd BEFORE the credential is used, so a credential is never accepted in
 * the clear. In dev `REQUIRE_TLS=false` disables the check.
 *
 * Origin check: for web (client-provenance) builds, an allowed-domain check
 * (ops-envelope §9) defeats casual curl abuse of the public sdk_key. Only
 * enforced when `ALLOWED_ORIGINS` is set AND the request carries an `Origin`
 * header (server-to-server callers send none, so they are unaffected).
 */
@Injectable()
export class IngestAuthGuard implements CanActivate {
  private readonly requireTls: boolean;
  private readonly allowedOrigins: string[];

  constructor(
    private readonly resolver: CredentialResolver,
    config: ConfigService,
  ) {
    this.requireTls = config.get<boolean>('REQUIRE_TLS') ?? false;
    this.allowedOrigins = (config.get<string>('ALLOWED_ORIGINS') ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o !== '');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    // TLS refusal FIRST — never even inspect the credential over plain HTTP.
    if (this.requireTls && !this.isSecure(request)) {
      throw new ForbiddenException('TLS required: ingest bearer auth is refused over plain HTTP');
    }

    // Origin allow-list for web builds (only when both configured + present).
    const origin = this.header(request, 'origin');
    if (this.allowedOrigins.length > 0 && origin !== undefined && !this.allowedOrigins.includes(origin)) {
      throw new ForbiddenException('Origin not allowed');
    }

    const header = request.headers['authorization'];
    const credential = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    const scope = await this.resolver.resolve(credential);
    if (!scope) {
      // FR-003: unknown/revoked key → reject, nothing recorded.
      throw new UnauthorizedException('Invalid or unknown ingest credential');
    }

    // Server-derived scope — the body's game_id/provenance are ignored downstream.
    request.game_id = scope.gameId;
    request.provenance = scope.provenance;
    return true;
  }

  /** True iff the request arrived over TLS (proxy header or direct TLS socket). */
  private isSecure(request: AuthenticatedRequest): boolean {
    const forwarded = this.header(request, 'x-forwarded-proto');
    if (forwarded !== undefined) {
      // A proxy may send a comma list; the first hop is the client-facing scheme.
      return forwarded.split(',')[0]!.trim().toLowerCase() === 'https';
    }
    // Direct TLS socket (no proxy) — Express sets req.secure from the connection.
    return (request as unknown as { secure?: boolean }).secure === true;
  }

  /** Read a header value as a single string (first value if an array). */
  private header(request: AuthenticatedRequest, name: string): string | undefined {
    const value = request.headers[name];
    if (Array.isArray(value)) {
      return value[0];
    }
    return typeof value === 'string' ? value : undefined;
  }
}
