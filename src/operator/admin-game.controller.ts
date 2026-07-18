/**
 * Admin game + credential controller (T-10.12-20/T-10.33) — API-only.
 *
 * RBAC (T-10.11): reads (list games/keys/creds, last_used_at) are allowed to any
 * authenticated operator (viewer or admin); writes (register, issue/rotate/revoke
 * keys + creds, retire) require @Roles('admin'). OperatorSessionGuard +
 * RolesGuard are applied at the controller level.
 *
 * Show-once (T-10.16/40): issue/create endpoints return the RAW credential in the
 * response body exactly once; subsequent list endpoints return prefix/metadata
 * only. Revoking an sdk_key requires an explicit `confirmDark` acknowledgement
 * (T-10.15).
 */

import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CredentialService, type CredentialView, type IssuedCredential } from './credential.service';
import { OperatorSessionGuard } from './operator-session.guard';
import { RolesGuard } from './roles.guard';
import { Roles } from './roles.decorator';

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

@Controller('admin/games')
@UseGuards(OperatorSessionGuard, RolesGuard)
export class AdminGameController {
  constructor(private readonly credentials: CredentialService) {}

  // ── reads (viewer + admin) ──────────────────────────────────────────────────

  @Get()
  listGames(): Promise<Array<{ gameId: string; name: string; registeredAt: Date }>> {
    return this.credentials.listGames();
  }

  @Get(':gameId/sdk-keys')
  listSdkKeys(@Param('gameId') gameId: string): Promise<CredentialView[]> {
    return this.credentials.listSdkKeys(gameId);
  }

  @Get(':gameId/server-credentials')
  listServerCredentials(@Param('gameId') gameId: string): Promise<CredentialView[]> {
    return this.credentials.listServerCredentials(gameId);
  }

  // ── writes (admin only) ──────────────────────────────────────────────────────

  @Post()
  @Roles('admin')
  async register(@Body() body: { gameId?: unknown; name?: unknown }): Promise<{
    game: { gameId: string; name: string };
    sdkKey: IssuedCredential;
  }> {
    const gameId = asString(body.gameId);
    const name = asString(body.name);
    if (gameId === undefined || name === undefined) {
      throw new BadRequestException('gameId and name are required');
    }
    return this.credentials.registerGame(gameId, name);
  }

  @Post(':gameId/sdk-keys')
  @Roles('admin')
  issueSdkKey(@Param('gameId') gameId: string): Promise<IssuedCredential> {
    return this.credentials.issueSdkKey(gameId);
  }

  @Post(':gameId/sdk-keys/:keyId/revoke')
  @Roles('admin')
  async revokeSdkKey(
    @Param('gameId') gameId: string,
    @Param('keyId') keyId: string,
    @Body() body: { confirmDark?: unknown },
  ): Promise<{ ok: true }> {
    await this.credentials.revokeSdkKey(gameId, keyId, body.confirmDark === true);
    return { ok: true };
  }

  @Post(':gameId/server-credentials')
  @Roles('admin')
  createServerCredential(@Param('gameId') gameId: string): Promise<IssuedCredential> {
    return this.credentials.createServerCredential(gameId);
  }

  @Post(':gameId/server-credentials/:credentialId/revoke')
  @Roles('admin')
  async revokeServerCredential(
    @Param('gameId') gameId: string,
    @Param('credentialId') credentialId: string,
  ): Promise<{ ok: true }> {
    await this.credentials.revokeServerCredential(gameId, credentialId);
    return { ok: true };
  }

  @Post(':gameId/retire')
  @Roles('admin')
  retire(@Param('gameId') gameId: string): Promise<{ sdkKeysRevoked: number; serverCredentialsRevoked: number }> {
    return this.credentials.retireGame(gameId);
  }
}
