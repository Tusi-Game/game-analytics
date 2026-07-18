import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { DataSource, IsNull } from 'typeorm';
import { CredentialResolver } from './credential-resolver.service';
import { GameSdkKeyEntity } from '../database/entities/game-sdk-key.entity';
import { hashCredential } from '../operator/credential-hash';

/**
 * Credential → game-scope resolver (T-01.17 / T-10.2-3, FR-003, DARK-SPOT #9),
 * REWRITTEN for the 011 child-table + keyed-hash path. Proves:
 *   - a hashed sdk_key child row → provenance=client;
 *   - a hashed server_credential child row → provenance=server;
 *   - unknown/revoked → null (auth fails, nothing recorded);
 *   - a revoked row (revoked_at set) is filtered by the IsNull() predicate;
 *   - a positive resolution is cached (no repeat DB read within TTL);
 *   - a successful resolve stamps the R7 last-use coalesce hash.
 * Uses faked repositories + a fake redis; the master key is a fixed test value.
 */

const MASTER = 'test-master';

interface SdkRow {
  gameId: string;
  keyId: string;
  keyHash: string;
  revokedAt: Date | null;
}
interface SrvRow {
  gameId: string;
  credentialId: string;
  credentialHash: string;
  revokedAt: Date | null;
}

/** Matches the service's `where: { <hashField>: hash, revokedAt: IsNull() }`. */
function isNullMarker(v: unknown): boolean {
  return JSON.stringify(v) === JSON.stringify(IsNull());
}

function makeDataSource(sdkRows: SdkRow[], srvRows: SrvRow[]): { ds: DataSource; findOnes: () => number } {
  const state = { findOnes: 0 };
  const sdkRepo = {
    findOne: async (opts: { where: { keyHash: string; revokedAt: unknown } }): Promise<SdkRow | null> => {
      state.findOnes += 1;
      const wantNonRevoked = isNullMarker(opts.where.revokedAt);
      return sdkRows.find((r) => r.keyHash === opts.where.keyHash && (!wantNonRevoked || r.revokedAt === null)) ?? null;
    },
  };
  const srvRepo = {
    findOne: async (opts: { where: { credentialHash: string; revokedAt: unknown } }): Promise<SrvRow | null> => {
      state.findOnes += 1;
      const wantNonRevoked = isNullMarker(opts.where.revokedAt);
      return (
        srvRows.find(
          (r) => r.credentialHash === opts.where.credentialHash && (!wantNonRevoked || r.revokedAt === null),
        ) ?? null
      );
    },
  };
  const ds = {
    getRepository: (entity: unknown) => (entity === GameSdkKeyEntity ? sdkRepo : srvRepo),
  } as unknown as DataSource;
  return { ds, findOnes: () => state.findOnes };
}

function fakeRedis(): { redis: Redis; hsetCount: () => number } {
  const state = { hsets: 0 };
  const redis = {
    hset: async (): Promise<number> => {
      state.hsets += 1;
      return 1;
    },
    expire: async (): Promise<number> => 1,
  } as unknown as Redis;
  return { redis, hsetCount: () => state.hsets };
}

function makeResolver(sdkRows: SdkRow[], srvRows: SrvRow[]) {
  const { ds, findOnes } = makeDataSource(sdkRows, srvRows);
  const config = { get: () => MASTER } as unknown as ConfigService;
  const r = fakeRedis();
  return { resolver: new CredentialResolver(ds, config, r.redis), findOnes, redis: r };
}

describe('CredentialResolver (011 child-table + keyed-hash)', () => {
  it('sdk_key child (non-revoked) → provenance=client, game from the row', async () => {
    const raw = 'pk_client_42';
    const { resolver } = makeResolver(
      [{ gameId: 'game-42', keyId: 'k1', keyHash: hashCredential(MASTER, raw), revokedAt: null }],
      [],
    );
    expect(await resolver.resolve(raw)).toEqual({ gameId: 'game-42', provenance: 'client' });
  });

  it('server_credential child (non-revoked) → provenance=server', async () => {
    const raw = 'sk_server_7';
    const { resolver } = makeResolver(
      [],
      [{ gameId: 'game-7', credentialId: 'c1', credentialHash: hashCredential(MASTER, raw), revokedAt: null }],
    );
    expect(await resolver.resolve(raw)).toEqual({ gameId: 'game-7', provenance: 'server' });
  });

  it('unknown / empty credential → null (auth fails, nothing recorded)', async () => {
    const { resolver } = makeResolver([], []);
    expect(await resolver.resolve('nope')).toBeNull();
    expect(await resolver.resolve('')).toBeNull();
  });

  it('revoked sdk_key → null (revoked_at filtered by IsNull predicate)', async () => {
    const raw = 'pk_revoked';
    const { resolver } = makeResolver(
      [{ gameId: 'g', keyId: 'k1', keyHash: hashCredential(MASTER, raw), revokedAt: new Date() }],
      [],
    );
    expect(await resolver.resolve(raw)).toBeNull();
  });

  it('dual-active: two non-revoked sdk_keys both resolve to the same game', async () => {
    const rawA = 'pk_A';
    const rawB = 'pk_B';
    const { resolver } = makeResolver(
      [
        { gameId: 'g', keyId: 'k1', keyHash: hashCredential(MASTER, rawA), revokedAt: null },
        { gameId: 'g', keyId: 'k2', keyHash: hashCredential(MASTER, rawB), revokedAt: null },
      ],
      [],
    );
    expect(await resolver.resolve(rawA)).toEqual({ gameId: 'g', provenance: 'client' });
    expect(await resolver.resolve(rawB)).toEqual({ gameId: 'g', provenance: 'client' });
  });

  it('caches a positive resolution (no repeat DB read within TTL)', async () => {
    const raw = 'pk_cache';
    const { resolver, findOnes } = makeResolver(
      [{ gameId: 'g', keyId: 'k1', keyHash: hashCredential(MASTER, raw), revokedAt: null }],
      [],
    );
    await resolver.resolve(raw);
    const before = findOnes();
    await resolver.resolve(raw); // served from cache
    expect(findOnes()).toBe(before);
  });

  it('stamps the R7 last-use coalesce hash on a positive resolve', async () => {
    const raw = 'pk_stamp';
    const { resolver, redis } = makeResolver(
      [{ gameId: 'g', keyId: 'k1', keyHash: hashCredential(MASTER, raw), revokedAt: null }],
      [],
    );
    await resolver.resolve(raw);
    // hset is fire-and-forget; give the microtask queue a tick to run.
    await new Promise((r) => setImmediate(r));
    expect(redis.hsetCount()).toBeGreaterThanOrEqual(1);
  });
});
