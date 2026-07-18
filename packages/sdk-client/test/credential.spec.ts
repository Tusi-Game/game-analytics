import { AnalyticsClient } from '../src/client';
import { FakeClock, FakeTimers, MockIngest, makeHooks } from './helpers';

/**
 * Credential-class fail-fast (T-08.58, Foundation §4.5). A wrong-class key
 * throws at `init` BEFORE any network call — proven by the mock ingest recording
 * zero POSTs.
 */
describe('client credential-class fail-fast', () => {
  function ctx() {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const ingest = new MockIngest();
    return { ingest, hooks: makeHooks(clock, timers, ingest) };
  }

  it('rejects a secret server credential (sk_) with NO network call', async () => {
    const { ingest, hooks } = ctx();
    await expect(
      AnalyticsClient.init({ sdkKey: 'sk_secret_server_xxx', endpoint: 'https://a.example.com' }, hooks),
    ).rejects.toThrow(/server credential.*CLIENT SDK|Refusing to initialize/i);
    expect(ingest.posts).toHaveLength(0); // pre-network
  });

  it('rejects an unrecognized credential class pre-network', async () => {
    const { ingest, hooks } = ctx();
    await expect(
      AnalyticsClient.init({ sdkKey: 'zz_unknown', endpoint: 'https://a.example.com' }, hooks),
    ).rejects.toThrow(/client-class key/i);
    expect(ingest.posts).toHaveLength(0);
  });

  it('rejects an empty key', async () => {
    const { hooks } = ctx();
    await expect(AnalyticsClient.init({ sdkKey: '', endpoint: 'https://a.example.com' }, hooks)).rejects.toThrow(
      /sdk_key is required/i,
    );
  });

  it('accepts a well-formed client key (pk_)', async () => {
    const { hooks } = ctx();
    const sdk = await AnalyticsClient.init({ sdkKey: 'pk_live_xxx', endpoint: 'https://a.example.com' }, hooks);
    expect(sdk).toBeInstanceOf(AnalyticsClient);
    sdk.dispose();
  });
});
