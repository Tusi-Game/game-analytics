/**
 * Credential → game-scope resolver (T-01.17 / T-10.2-3-20, foundation §4.5) —
 * the trust boundary of the whole platform. REWRITTEN by 011 (research-brief
 * BLOCKER #1/#2): resolves against the 1..N credential CHILD tables
 * (`GAME_SDK_KEY` / `GAME_SERVER_CREDENTIAL`) by the KEYED HASH of the incoming
 * credential, honoring `revoked_at IS NULL`, instead of the deprecated inline
 * `GAME.sdk_key` / `GAME.server_credential` scalars.
 *
 * Contract UNCHANGED for 002: `resolve(credential) → { gameId, provenance } | null`.
 *   - a hash match in `game_sdk_key` (non-revoked)         → `provenance = client`;
 *   - a hash match in `game_server_credential` (non-revoked) → `provenance = server`;
 *   - unknown / revoked / unclassifiable                    → null → guard fails
 *     auth, NOTHING recorded (FR-003).
 *
 * ANY non-revoked child row is valid — this is what enables DUAL-ACTIVE rotation
 * (≥ 2 keys live at once). Lookup is by a UNIQUE-indexed `key_hash` /
 * `credential_hash`, so it is O(1) single-row.
 *
 * A short positive cache avoids a Postgres read per request; unknown/revoked keys
 * are NOT cached (a just-issued key works immediately; a bad-key storm can't fill
 * the cache; a revoked key stops working within one cache TTL).
 *
 * R7 last-use stamping: on a positive resolve we COALESCE the last-use into a
 * TTL-bounded Redis hash (`{game}:ops:creduse`, LWW, O(1), NO Postgres write on
 * the hot path). The flush sweep drains it into the child row's `last_used_at`
 * (see FlushJobService). This is best-effort telemetry — a Redis miss just means
 * a slightly stale `last_used_at`, never a correctness issue.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { DataSource, IsNull } from 'typeorm';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { CRED_USE_TTL_SECONDS, OpsKeys, credUseField } from '../common/redis-keys/redis-keys';
import { GameSdkKeyEntity } from '../database/entities/game-sdk-key.entity';
import { GameServerCredentialEntity } from '../database/entities/game-server-credential.entity';
import { hashCredential } from '../operator/credential-hash';
import type { Provenance } from '../common/http/authenticated-request';

/** A resolved game scope: which game + how the caller authenticated. */
export interface ResolvedScope {
  gameId: string;
  provenance: Provenance;
}

interface CacheEntry {
  scope: ResolvedScope;
  /** The child id, for the last-use stamp field. */
  credId: string;
  kind: 'sdk' | 'srv';
  readAt: number;
}

/** Positive-cache TTL (ms). Kept short so revocation propagates promptly. */
const CACHE_TTL_MS = 30_000;

@Injectable()
export class CredentialResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly master: string;
  private readonly logger = new Logger(CredentialResolver.name);

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.master = config.get<string>('SECRET_MASTER_KEY') ?? '';
  }

  /**
   * Resolve a bearer credential to its game scope, or null if unknown/revoked.
   * Client (`sdk_key`) is checked first, then server (`server_credential`); a
   * credential matching neither non-revoked class → null (auth fails).
   */
  async resolve(credential: string): Promise<ResolvedScope | null> {
    if (credential.length === 0) {
      return null;
    }
    const cached = this.cache.get(credential);
    if (cached && Date.now() - cached.readAt < CACHE_TTL_MS) {
      void this.stampLastUse(cached.scope.gameId, cached.kind, cached.credId);
      return cached.scope;
    }

    const hash = hashCredential(this.master, credential);

    // Client class: public sdk_key child (non-revoked). ANY non-revoked row valid.
    const sdk = await this.dataSource.getRepository(GameSdkKeyEntity).findOne({
      where: { keyHash: hash, revokedAt: IsNull() },
      select: { gameId: true, keyId: true },
    });
    if (sdk) {
      void this.stampLastUse(sdk.gameId, 'sdk', sdk.keyId);
      return this.cacheAndReturn(credential, { gameId: sdk.gameId, provenance: 'client' }, 'sdk', sdk.keyId);
    }

    // Server class: secret server_credential child (non-revoked).
    const srv = await this.dataSource.getRepository(GameServerCredentialEntity).findOne({
      where: { credentialHash: hash, revokedAt: IsNull() },
      select: { gameId: true, credentialId: true },
    });
    if (srv) {
      void this.stampLastUse(srv.gameId, 'srv', srv.credentialId);
      return this.cacheAndReturn(credential, { gameId: srv.gameId, provenance: 'server' }, 'srv', srv.credentialId);
    }

    // Unknown / revoked — NOT cached (see class comment).
    return null;
  }

  private cacheAndReturn(credential: string, scope: ResolvedScope, kind: 'sdk' | 'srv', credId: string): ResolvedScope {
    this.cache.set(credential, { scope, kind, credId, readAt: Date.now() });
    return scope;
  }

  /**
   * R7: coalesce the last-use into a TTL-bounded Redis hash (LWW, O(1), no PG).
   * Best-effort — swallow errors so telemetry never blocks or fails ingest auth.
   */
  private async stampLastUse(gameId: string, kind: 'sdk' | 'srv', credId: string): Promise<void> {
    try {
      const key = OpsKeys.credUse(gameId);
      await this.redis.hset(key, credUseField(kind, credId), Date.now().toString());
      await this.redis.expire(key, CRED_USE_TTL_SECONDS);
    } catch (err) {
      this.logger.debug(`last-use stamp skipped (redis): ${(err as Error).message}`);
    }
  }

  /** Drop a credential from the positive cache (tests / after a known rotation). */
  invalidate(credential: string): void {
    this.cache.delete(credential);
  }
}
