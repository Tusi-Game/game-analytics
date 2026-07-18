import { DataSource } from 'typeorm';
import { CredentialResolver } from './credential-resolver.service';

/**
 * Credential → game-scope resolver (T-01.17, FR-003, DARK-SPOT #9). Proves the
 * server-derived provenance mapping and that unknown/revoked credentials resolve
 * to null (auth fails, nothing recorded). Uses a faked repository.
 */

interface FakeRow {
  gameId: string;
}

function makeDataSource(byField: { sdkKey?: Record<string, FakeRow>; serverCredential?: Record<string, FakeRow> }): {
  ds: DataSource;
  calls: number;
} {
  const state = { calls: 0 };
  const repo = {
    findOne: async (opts: { where: Record<string, string> }): Promise<FakeRow | null> => {
      state.calls += 1;
      if ('sdkKey' in opts.where) {
        return byField.sdkKey?.[opts.where.sdkKey] ?? null;
      }
      if ('serverCredential' in opts.where) {
        return byField.serverCredential?.[opts.where.serverCredential] ?? null;
      }
      return null;
    },
  };
  const ds = { getRepository: () => repo } as unknown as DataSource;
  return { ds, calls: state.calls };
}

describe('CredentialResolver', () => {
  it('public sdk_key → provenance=client, resolved game from the key', async () => {
    const { ds } = makeDataSource({ sdkKey: { sdk_pub_42: { gameId: 'game-42' } } });
    const resolver = new CredentialResolver(ds);
    const scope = await resolver.resolve('sdk_pub_42');
    expect(scope).toEqual({ gameId: 'game-42', provenance: 'client' });
  });

  it('server_credential → provenance=server', async () => {
    const { ds } = makeDataSource({ serverCredential: { srv_secret_7: { gameId: 'game-7' } } });
    const resolver = new CredentialResolver(ds);
    const scope = await resolver.resolve('srv_secret_7');
    expect(scope).toEqual({ gameId: 'game-7', provenance: 'server' });
  });

  it('unknown / revoked credential → null (auth fails, nothing recorded)', async () => {
    const { ds } = makeDataSource({});
    const resolver = new CredentialResolver(ds);
    expect(await resolver.resolve('nope')).toBeNull();
    expect(await resolver.resolve('')).toBeNull();
  });

  it('caches a positive resolution (no repeat DB read within TTL)', async () => {
    const state = { findOnes: 0 };
    const repo = {
      findOne: async (opts: { where: Record<string, string> }) => {
        state.findOnes += 1;
        return 'sdkKey' in opts.where && opts.where.sdkKey === 'k' ? { gameId: 'g' } : null;
      },
    };
    const ds = { getRepository: () => repo } as unknown as DataSource;
    const resolver = new CredentialResolver(ds);
    await resolver.resolve('k');
    const before = state.findOnes;
    await resolver.resolve('k'); // served from cache
    expect(state.findOnes).toBe(before);
  });
});
