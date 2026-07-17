import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import type { AuthenticatedRequest } from '../http/authenticated-request';

/**
 * SDK-key authentication guard (SKELETON — spec 011 implements real auth).
 *
 * Contract for downstream code:
 *   - resolves the SDK key from `Authorization: Bearer <key>` into a `game_id`,
 *     which it attaches to `request.game_id`;
 *   - attaches the request `provenance` to `request.provenance`.
 *
 * In this scaffold it does NOT validate the key. It reads the bearer token if
 * present, stamps a placeholder `game_id`, and always returns `true` so the app
 * boots and routes are reachable in dev. Spec 011 replaces the body with a real
 * lookup against the game registry and rejects unknown/expired keys.
 */
@Injectable()
export class SdkKeyGuard implements CanActivate {
  private static readonly PLACEHOLDER_GAME_ID = 'dev-game';
  private readonly logger = new Logger(SdkKeyGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers['authorization'];
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : undefined;

    // SKELETON: no key validation. Stamp a placeholder game_id + provenance so
    // downstream handlers and decorators have a typed value to read.
    request.game_id = SdkKeyGuard.PLACEHOLDER_GAME_ID;
    request.provenance = 'client';

    if (!bearer) {
      this.logger.debug('No SDK key present — dev skeleton stamps placeholder game_id.');
    }

    return true;
  }
}
