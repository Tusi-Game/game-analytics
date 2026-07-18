/**
 * Credential → game-scope resolver (T-01.17, foundation §4.5) — the trust
 * boundary of the whole platform.
 *
 * Resolves the header credential to `{ game_id, provenance }` SERVER-SIDE from
 * the credential's CLASS, never from the request body (P12/P5, DARK-SPOT #9):
 *   - a public `sdk_key`         → `provenance = client`;
 *   - a secret `server_credential` → `provenance = server`.
 *
 * Unknown / revoked / unclassifiable credential → returns null → the guard fails
 * auth and NOTHING is recorded (FR-003). A short positive cache avoids a Postgres
 * read per request; unknown keys are NOT cached (so a just-registered key works
 * immediately and a probe storm of bad keys cannot fill the cache).
 *
 * The full 1..N credential-child tables are 011's; this reads the minimal scalar
 * `sdk_key` / `server_credential` surface on GAME (the T-01.6 seed provides a
 * real row so ingest auth works before 011).
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GameEntity } from '../database/entities/game.entity';
import type { Provenance } from '../common/http/authenticated-request';

/** A resolved game scope: which game + how the caller authenticated. */
export interface ResolvedScope {
  gameId: string;
  provenance: Provenance;
}

interface CacheEntry {
  scope: ResolvedScope;
  readAt: number;
}

/** Positive-cache TTL (ms). Kept short so revocation propagates promptly. */
const CACHE_TTL_MS = 30_000;

@Injectable()
export class CredentialResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Resolve a bearer credential to its game scope, or null if unknown/revoked.
   * Client (`sdk_key`) is checked first, then server (`server_credential`). A
   * credential matching neither class → null (auth fails, nothing recorded).
   */
  async resolve(credential: string): Promise<ResolvedScope | null> {
    if (credential.length === 0) {
      return null;
    }
    const cached = this.cache.get(credential);
    if (cached && Date.now() - cached.readAt < CACHE_TTL_MS) {
      return cached.scope;
    }

    const repo = this.dataSource.getRepository(GameEntity);

    // Client class: public sdk_key (UNIQUE).
    const byClientKey = await repo.findOne({ where: { sdkKey: credential }, select: { gameId: true } });
    if (byClientKey) {
      return this.cacheAndReturn(credential, { gameId: byClientKey.gameId, provenance: 'client' });
    }

    // Server class: secret server_credential (stored hashed; scalar surface here).
    const byServerCred = await repo.findOne({ where: { serverCredential: credential }, select: { gameId: true } });
    if (byServerCred) {
      return this.cacheAndReturn(credential, { gameId: byServerCred.gameId, provenance: 'server' });
    }

    // Unknown / revoked — NOT cached (see class comment).
    return null;
  }

  private cacheAndReturn(credential: string, scope: ResolvedScope): ResolvedScope {
    this.cache.set(credential, { scope, readAt: Date.now() });
    return scope;
  }

  /** Drop a credential from the positive cache (tests / after a known rotation). */
  invalidate(credential: string): void {
    this.cache.delete(credential);
  }
}
