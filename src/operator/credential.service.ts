/**
 * Game registration + credential lifecycle (T-10.12-20) — the Q2 two-class model
 * made operational, sole write-path into GAME + its credential children (P9: the
 * resolver only READS these).
 *
 * Show-once contract: create/issue returns the RAW credential exactly once; only
 * `*_hash` (shared keyed-hash scheme, credential-hash.ts) + `*_prefix` +
 * `created_at` persist. Never retrievable again.
 *
 * Dual-active: validity = `revoked_at IS NULL`. Rotation = insert a new row (both
 * valid) → deploy → watch the old `last_used_at` drain → revoke the old. Revoking
 * an sdk_key is an EMERGENCY (shipped builds go dark → drop-and-tally): the method
 * REQUIRES an explicit `confirmDark` flag.
 *
 * `last_used_at` is stamped off the hot path (resolver → Redis coalesce → flush);
 * this service only READS it so the operator can watch a rotated key drain.
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, IsNull } from 'typeorm';
import { GameEntity } from '../database/entities/game.entity';
import { GameSdkKeyEntity } from '../database/entities/game-sdk-key.entity';
import { GameServerCredentialEntity } from '../database/entities/game-server-credential.entity';
import { credentialPrefix, generateSdkKey, generateServerCredential, hashCredential } from './credential-hash';

/** A freshly issued credential — the RAW value is shown ONCE here. */
export interface IssuedCredential {
  id: string;
  gameId: string;
  prefix: string;
  /** The raw credential — returned ONCE; never persisted, never retrievable. */
  raw: string;
  createdAt: Date;
}

/** A credential's viewable (non-secret) metadata for the admin read surface. */
export interface CredentialView {
  id: string;
  gameId: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface GameRegistration {
  game: { gameId: string; name: string };
  /** The auto-issued public sdk_key — shown ONCE. */
  sdkKey: IssuedCredential;
}

@Injectable()
export class CredentialService {
  private readonly master: string;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.master = config.get<string>('SECRET_MASTER_KEY') ?? '';
  }

  // ── Game registration (T-10.12) ────────────────────────────────────────────

  /**
   * Register a game: create the GAME row and auto-issue exactly ONE public
   * sdk_key (shown once). Does NOT auto-issue a server_credential (on demand).
   */
  async registerGame(gameId: string, name: string): Promise<GameRegistration> {
    const gameRepo = this.dataSource.getRepository(GameEntity);
    const existing = await gameRepo.findOne({ where: { gameId } });
    if (existing) {
      throw new BadRequestException(`game "${gameId}" already exists`);
    }
    await gameRepo.insert({
      gameId,
      name,
      sdkKey: null,
      serverCredential: null,
      config: {},
      registeredAt: new Date(),
    });
    const sdkKey = await this.issueSdkKey(gameId);
    return { game: { gameId, name }, sdkKey };
  }

  /** List registered games (admin read surface, T-10.33/35). */
  async listGames(): Promise<Array<{ gameId: string; name: string; registeredAt: Date }>> {
    const rows = await this.dataSource.getRepository(GameEntity).find({ order: { registeredAt: 'ASC' } });
    return rows.map((r) => ({ gameId: r.gameId, name: r.name, registeredAt: r.registeredAt }));
  }

  // ── sdk_key lifecycle (T-10.14/15/18) ──────────────────────────────────────

  /** Issue (or rotate in) a new public sdk_key for a game — shown once. */
  async issueSdkKey(gameId: string): Promise<IssuedCredential> {
    await this.assertGameExists(gameId);
    const raw = generateSdkKey();
    const id = randomUUID();
    const createdAt = new Date();
    await this.dataSource.getRepository(GameSdkKeyEntity).insert({
      gameId,
      keyId: id,
      keyPrefix: credentialPrefix(raw),
      keyHash: hashCredential(this.master, raw),
      createdAt,
      lastUsedAt: null,
      revokedAt: null,
    });
    return { id, gameId, prefix: credentialPrefix(raw), raw, createdAt };
  }

  /** View a game's sdk_keys (public metadata only). */
  async listSdkKeys(gameId: string): Promise<CredentialView[]> {
    const rows = await this.dataSource
      .getRepository(GameSdkKeyEntity)
      .find({ where: { gameId }, order: { createdAt: 'ASC' } });
    return rows.map((r) => ({
      id: r.keyId,
      gameId: r.gameId,
      prefix: r.keyPrefix,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
    }));
  }

  /**
   * Revoke an sdk_key — an EMERGENCY action. All shipped builds using it go dark
   * at ingest (events become drop-and-tally, Foundation §4.4). The caller MUST
   * pass `confirmDark: true` acknowledging this; otherwise the call is refused.
   */
  async revokeSdkKey(gameId: string, keyId: string, confirmDark: boolean): Promise<void> {
    if (confirmDark !== true) {
      throw new BadRequestException(
        'Revoking an sdk_key is an emergency action: all shipped builds using it will go dark at ' +
          'ingest (drop-and-tally). Re-issue the call with confirmDark=true to proceed.',
      );
    }
    const repo = this.dataSource.getRepository(GameSdkKeyEntity);
    const row = await repo.findOne({ where: { gameId, keyId } });
    if (!row) {
      throw new NotFoundException('sdk_key not found');
    }
    if (row.revokedAt === null) {
      await repo.update({ gameId, keyId }, { revokedAt: new Date() });
    }
  }

  // ── server_credential lifecycle (T-10.16/17) ───────────────────────────────

  /** Create a server_credential on demand — shown ONCE, stored hashed. */
  async createServerCredential(gameId: string): Promise<IssuedCredential> {
    await this.assertGameExists(gameId);
    const raw = generateServerCredential();
    const id = randomUUID();
    const createdAt = new Date();
    await this.dataSource.getRepository(GameServerCredentialEntity).insert({
      gameId,
      credentialId: id,
      credentialPrefix: credentialPrefix(raw),
      credentialHash: hashCredential(this.master, raw),
      createdAt,
      lastUsedAt: null,
      revokedAt: null,
    });
    return { id, gameId, prefix: credentialPrefix(raw), raw, createdAt };
  }

  /** View a game's server_credentials (public metadata only; never the secret). */
  async listServerCredentials(gameId: string): Promise<CredentialView[]> {
    const rows = await this.dataSource
      .getRepository(GameServerCredentialEntity)
      .find({ where: { gameId }, order: { createdAt: 'ASC' } });
    return rows.map((r) => ({
      id: r.credentialId,
      gameId: r.gameId,
      prefix: r.credentialPrefix,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
    }));
  }

  /** Revoke a server_credential (immediate). Dual-active: others stay valid. */
  async revokeServerCredential(gameId: string, credentialId: string): Promise<void> {
    const repo = this.dataSource.getRepository(GameServerCredentialEntity);
    const row = await repo.findOne({ where: { gameId, credentialId } });
    if (!row) {
      throw new NotFoundException('server_credential not found');
    }
    if (row.revokedAt === null) {
      await repo.update({ gameId, credentialId }, { revokedAt: new Date() });
    }
  }

  // ── Retire (T-10.19) ────────────────────────────────────────────────────────

  /**
   * Retire a game: revoke ALL non-revoked sdk_keys + server_credentials (ingest
   * stops) while keeping results + raw intact (retirement ≠ erasure). Returns the
   * count revoked per class. Idempotent (already-revoked rows are skipped).
   */
  async retireGame(gameId: string): Promise<{ sdkKeysRevoked: number; serverCredentialsRevoked: number }> {
    await this.assertGameExists(gameId);
    const now = new Date();
    const sdkRes = await this.dataSource
      .getRepository(GameSdkKeyEntity)
      .update({ gameId, revokedAt: IsNull() }, { revokedAt: now });
    const srvRes = await this.dataSource
      .getRepository(GameServerCredentialEntity)
      .update({ gameId, revokedAt: IsNull() }, { revokedAt: now });
    return { sdkKeysRevoked: sdkRes.affected ?? 0, serverCredentialsRevoked: srvRes.affected ?? 0 };
  }

  private async assertGameExists(gameId: string): Promise<void> {
    const exists = await this.dataSource.getRepository(GameEntity).findOne({ where: { gameId } });
    if (!exists) {
      throw new NotFoundException(`game "${gameId}" not found`);
    }
  }
}
