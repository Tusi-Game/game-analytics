import { AnalyticsServer } from '../src/server';
import { FakeClock, fakeSleep, MockIngest } from './helpers';

/**
 * Credential-class fail-fast (T-08.58, Foundation §4.5). A public client key
 * (pk_) supplied to the server SDK throws at `init` BEFORE any network call —
 * proven by the mock ingest recording zero POSTs.
 */
describe('server credential-class fail-fast', () => {
  function hooks() {
    const clock = new FakeClock();
    const ingest = new MockIngest();
    return { ingest, h: { now: clock.now, sleep: fakeSleep(clock), fetchImpl: ingest.fetchImpl } };
  }

  it('rejects a public client sdk_key (pk_) with NO network call', () => {
    const { ingest, h } = hooks();
    expect(() =>
      AnalyticsServer.init({ serverCredential: 'pk_public_client_xxx', endpoint: 'https://a.example.com' }, h),
    ).toThrow(/PUBLIC client sdk_key.*SERVER SDK|Refusing to initialize/i);
    expect(ingest.posts).toHaveLength(0);
  });

  it('rejects an unrecognized credential class pre-network', () => {
    const { ingest, h } = hooks();
    expect(() =>
      AnalyticsServer.init({ serverCredential: 'zz_unknown', endpoint: 'https://a.example.com' }, h),
    ).toThrow(/server-class credential/i);
    expect(ingest.posts).toHaveLength(0);
  });

  it('rejects an empty credential', () => {
    const { h } = hooks();
    expect(() => AnalyticsServer.init({ serverCredential: '', endpoint: 'https://a.example.com' }, h)).toThrow(
      /server_credential is required/i,
    );
  });

  it('accepts a well-formed server credential (sk_)', async () => {
    const { h } = hooks();
    const sdk = AnalyticsServer.init({ serverCredential: 'sk_secret_xxx', endpoint: 'https://a.example.com' }, h);
    expect(sdk).toBeInstanceOf(AnalyticsServer);
    await sdk.shutdown();
  });
});
