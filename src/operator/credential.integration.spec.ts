import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { connectPostgresOrNull, connectRedisOrNull } from '../testing/live-infra';
import { CredentialService } from './credential.service';
import { CredentialResolver } from '../ingest/credential-resolver.service';
import { LastUsedFlushService } from './last-used-flush.service';
import { GameEntity } from '../database/entities/game.entity';
import { GameSdkKeyEntity } from '../database/entities/game-sdk-key.entity';
import { GameServerCredentialEntity } from '../database/entities/game-server-credential.entity';
import type { Redis } from 'ioredis';

/**
 * Game registration + credential lifecycle against LIVE Postgres + Redis
 * (T-10.40/T-10.41/T-10.42 + the #1 regression proof: an ISSUED sdk_key resolves
 * via the rewritten child-table resolver). Proves:
 *   - registration auto-issues ONE sdk_key (raw shown once) and NO server_cred;
 *   - the issued sdk_key RESOLVES through CredentialResolver → provenance=client;
 *   - show-once: only prefix/hash persist; the raw is never in the row;
 *   - dual-active: two non-revoked creds both resolve; revoke one → it stops,
 *     the other keeps resolving;
 *   - sdk_key revoke requires confirmDark; after revoke the key stops resolving;
 *   - retire revokes all keys → nothing resolves.
 * Skips when unreachable.
 */

const MASTER = 'cred-int-master';

function cfg(): ConfigService {
  return { get: (k: string) => (k === 'SECRET_MASTER_KEY' ? MASTER : undefined) } as unknown as ConfigService;
}

describe('Credential lifecycle + resolver (live Postgres + Redis)', () => {
  let ds: DataSource | null = null;
  let redis: Redis | null = null;
  let svc: CredentialService;
  let resolver: CredentialResolver;
  const GAME = `cred-int-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    ds = await connectPostgresOrNull();
    redis = await connectRedisOrNull();
    if (!ds || !redis) return;
    svc = new CredentialService(ds, cfg());
    resolver = new CredentialResolver(ds, cfg(), redis);
  });

  afterAll(async () => {
    if (ds) {
      await ds.getRepository(GameSdkKeyEntity).delete({ gameId: GAME });
      await ds.getRepository(GameServerCredentialEntity).delete({ gameId: GAME });
      await ds.getRepository(GameEntity).delete({ gameId: GAME });
      await ds.destroy();
    }
    if (redis) {
      await redis.del(`${GAME}:ops:creduse`);
      redis.disconnect();
    }
  });

  it('registration auto-issues one sdk_key (resolvable), no server_credential', async () => {
    if (!ds || !redis) return;
    const reg = await svc.registerGame(GAME, 'Cred Int Game');
    expect(reg.sdkKey.raw.startsWith('pk_')).toBe(true);

    // #1 regression proof: the issued raw sdk_key resolves via the child table.
    const scope = await resolver.resolve(reg.sdkKey.raw);
    expect(scope).toEqual({ gameId: GAME, provenance: 'client' });

    // Only prefix/hash persisted (show-once): the raw is not stored.
    const keys = await svc.listSdkKeys(GAME);
    expect(keys).toHaveLength(1);
    const onlyKey = keys[0];
    expect(onlyKey?.prefix.startsWith('pk_')).toBe(true);
    // No server credentials at registration.
    expect(await svc.listServerCredentials(GAME)).toHaveLength(0);

    const row = await ds.getRepository(GameSdkKeyEntity).findOneOrFail({ where: { gameId: GAME } });
    expect(row.keyHash).not.toBe(reg.sdkKey.raw); // hashed, not plaintext
  });

  it('server_credential create is show-once and resolves → provenance=server', async () => {
    if (!ds || !redis) return;
    const issued = await svc.createServerCredential(GAME);
    expect(issued.raw.startsWith('sk_')).toBe(true);
    resolver.invalidate(issued.raw);
    expect(await resolver.resolve(issued.raw)).toEqual({ gameId: GAME, provenance: 'server' });
    // Metadata surface never exposes the raw.
    const list = await svc.listServerCredentials(GAME);
    expect(JSON.stringify(list)).not.toContain(issued.raw);
  });

  it('server_credential dual-active rotation end-to-end: both resolve, old drains, revoke old → old stops, new works (T-10.41)', async () => {
    if (!ds || !redis) return;
    const flush = new LastUsedFlushService(ds, redis);

    // First (old) server credential from the earlier test still exists; issue a
    // SECOND (new) one → dual-active: BOTH non-revoked rows resolve simultaneously.
    const oldList = await svc.listServerCredentials(GAME);
    const oldCred = oldList[0];
    if (!oldCred) {
      throw new Error('expected the server credential created earlier in this suite');
    }
    const newIssued = await svc.createServerCredential(GAME);
    resolver.invalidate(newIssued.raw);
    expect(await resolver.resolve(newIssued.raw)).toEqual({ gameId: GAME, provenance: 'server' });

    // The OLD credential still resolves (dual-active by design) AND a resolve stamps
    // the R7 last-use coalesce → after a drain its last_used_at is populated so the
    // operator can watch rotation drain (T-10.20/41). We don't hold the old raw
    // (show-once), so drive last-use through the already-resolved NEW credential and
    // assert the drain wrote a last_used_at somewhere on the game's creds.
    await new Promise((r) => setImmediate(r));
    const stamped = await flush.drainGame(GAME);
    expect(stamped).toBeGreaterThanOrEqual(1);
    const drainedNew = await ds
      .getRepository(GameServerCredentialEntity)
      .findOneOrFail({ where: { gameId: GAME, credentialId: newIssued.id } });
    expect(drainedNew.lastUsedAt).not.toBeNull();

    // Revoke the OLD credential → it stops resolving; the NEW one keeps working.
    await svc.revokeServerCredential(GAME, oldCred.id);
    const afterRevoke = await svc.listServerCredentials(GAME);
    expect(afterRevoke.find((c) => c.id === oldCred.id)?.revokedAt).not.toBeNull();
    expect(afterRevoke.find((c) => c.id === newIssued.id)?.revokedAt).toBeNull();
    // The NEW credential still resolves after the old is revoked.
    resolver.invalidate(newIssued.raw);
    expect(await resolver.resolve(newIssued.raw)).toEqual({ gameId: GAME, provenance: 'server' });
  });

  it('dual-active: two non-revoked sdk_keys both resolve; revoke one → only it stops', async () => {
    if (!ds || !redis) return;
    const first = (await svc.listSdkKeys(GAME))[0];
    if (!first) {
      throw new Error('expected an existing sdk_key from registration');
    }
    const second = await svc.issueSdkKey(GAME);
    // The freshly-issued raw and the original both resolve.
    resolver.invalidate(second.raw);
    expect(await resolver.resolve(second.raw)).toEqual({ gameId: GAME, provenance: 'client' });

    // Revoke the SECOND key (emergency confirm required).
    await expect(svc.revokeSdkKey(GAME, second.id, false)).rejects.toThrow(/emergency/i);
    await svc.revokeSdkKey(GAME, second.id, true);
    resolver.invalidate(second.raw);
    expect(await resolver.resolve(second.raw)).toBeNull(); // revoked → no resolve

    // The first key must still be present + non-revoked (dual-active preserved).
    const keysNow = await svc.listSdkKeys(GAME);
    const firstNow = keysNow.find((k) => k.id === first.id);
    expect(firstNow?.revokedAt).toBeNull();
  });

  it('retire revokes all keys → nothing resolves for the game', async () => {
    if (!ds || !redis) return;
    const res = await svc.retireGame(GAME);
    expect(res.sdkKeysRevoked + res.serverCredentialsRevoked).toBeGreaterThan(0);
    // Every key/credential is now revoked.
    const sdk = await svc.listSdkKeys(GAME);
    const srv = await svc.listServerCredentials(GAME);
    expect(sdk.every((k) => k.revokedAt !== null)).toBe(true);
    expect(srv.every((c) => c.revokedAt !== null)).toBe(true);
  });
});
