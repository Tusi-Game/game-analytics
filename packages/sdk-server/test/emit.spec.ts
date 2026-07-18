import { AnalyticsServer } from '../src/server';
import { SERVER_KINDS } from '../src/wire';
import { FakeClock, fakeSleep, MockIngest } from './helpers';

/**
 * Server emission conformance (T-08.39–42): the [006-monetization §3] verified
 * revenue row (field names, source=server, NO normalized amount, relays
 * purchase_attempt_id, no local dedup), server-provenance economy, generic; and
 * the R11 invariant that the server SDK NEVER emits kind=session.
 */
describe('server SDK emissions', () => {
  function boot() {
    const clock = new FakeClock();
    const ingest = new MockIngest();
    // flush_on_purchase off → deterministic: emissions queue, one manual flush
    // ships them together (no fire-and-forget eager-flush races in assertions).
    const sdk = AnalyticsServer.init(
      { serverCredential: 'sk_test', endpoint: 'https://a.example.com/', flush_on_purchase: false },
      { now: clock.now, sleep: fakeSleep(clock), fetchImpl: ingest.fetchImpl },
    );
    return { sdk, clock, ingest };
  }

  const validPurchase = {
    userId: 'u-1',
    transactionId: 'T1',
    originalTransactionId: 'OT1',
    productId: 'gem_bundle_large',
    productCategory: 'consumable',
    priceLocal: 4.99,
    currency: 'USD',
    verified: true,
    environment: 'prod' as const,
    purchaseAttemptId: 'pa-0001',
  };

  it('verifiedPurchase emits kind=purchase source=server with the full [006 §3] field set', async () => {
    const { sdk, ingest } = boot();
    sdk.verifiedPurchase(validPurchase);
    await sdk.flush();
    const e = ingest.allEvents()[0]!;
    expect(e.kind).toBe('purchase');
    expect(e.name).toBe('purchase');
    expect(e.user_id).toBe('u-1');
    // [006 §3] required field names, byte-for-byte, inside props.
    expect(e.props).toMatchObject({
      source: 'server',
      transaction_id: 'T1',
      original_transaction_id: 'OT1',
      product_id: 'gem_bundle_large',
      product_category: 'consumable',
      price_local: 4.99,
      currency: 'USD',
      verified: true,
      environment: 'prod',
      purchase_attempt_id: 'pa-0001',
    });
    await sdk.shutdown();
  });

  it('relays purchase_attempt_id (R2 join key) exactly as supplied', async () => {
    const { sdk, ingest } = boot();
    sdk.verifiedPurchase({ ...validPurchase, purchaseAttemptId: 'pa-XYZ' });
    await sdk.flush();
    expect(ingest.allEvents()[0]!.props.purchase_attempt_id).toBe('pa-XYZ');
    await sdk.shutdown();
  });

  it('NEVER emits a normalized/converted amount, and never game_id/session_id/anon_id (no FX, Q8)', async () => {
    const { sdk, ingest } = boot();
    sdk.verifiedPurchase({ ...validPurchase, currency: 'IRR', priceLocal: 250000 });
    await sdk.flush();
    const e = ingest.allEvents()[0]!;
    for (const forbidden of [
      'normalized_amount',
      'normalized_revenue',
      'fx_rate',
      'price_usd',
      'amount_usd',
      'provenance',
    ]) {
      expect(e.props).not.toHaveProperty(forbidden);
    }
    expect(e).not.toHaveProperty('game_id');
    expect(e).not.toHaveProperty('session_id');
    expect(e).not.toHaveProperty('anon_id');
    expect(e).not.toHaveProperty('server_received_time');
    // Raw local + ISO currency ride the wire untouched.
    expect(e.props.price_local).toBe(250000);
    expect(e.props.currency).toBe('IRR');
    await sdk.shutdown();
  });

  it('does NOT locally dedup: two emissions of the same transaction_id both ship', async () => {
    const { sdk, ingest } = boot();
    sdk.verifiedPurchase(validPurchase);
    sdk.verifiedPurchase(validPurchase); // same transaction_id
    await sdk.flush();
    const purchases = ingest.allEvents().filter((e) => e.kind === 'purchase');
    expect(purchases).toHaveLength(2); // durable gate is the server's job, not the SDK's
    await sdk.shutdown();
  });

  it('optional refunded flag is carried when supplied, absent otherwise', async () => {
    const { sdk, ingest } = boot();
    sdk.verifiedPurchase({ ...validPurchase, refunded: true });
    await sdk.flush();
    expect(ingest.allEvents()[0]!.props.refunded).toBe(true);
    await sdk.shutdown();

    const { sdk: sdk2, ingest: ingest2 } = boot();
    sdk2.verifiedPurchase(validPurchase); // no refunded
    await sdk2.flush();
    expect(ingest2.allEvents()[0]!.props).not.toHaveProperty('refunded');
    await sdk2.shutdown();
  });

  it('economy emits server-provenance flow with NO provenance field', async () => {
    const { sdk, ingest } = boot();
    sdk.economy({
      userId: 'u-1',
      flowType: 'source',
      currencyType: 'gold',
      amount: 100,
      reason: 'quest_reward',
      balanceAfter: 500,
    });
    await sdk.flush();
    const e = ingest.allEvents()[0]!;
    expect(e.kind).toBe('economy');
    expect(e.props).toMatchObject({
      flow_type: 'source',
      currency_type: 'gold',
      amount: 100,
      reason: 'quest_reward',
      balance_after: 500,
    });
    expect(e.props).not.toHaveProperty('provenance'); // derived from credential
    expect(e.props).not.toHaveProperty('source');
    await sdk.shutdown();
  });

  it('track emits a generic event; optional relayed session_id passes through as opaque context', async () => {
    const { sdk, ingest } = boot();
    sdk.track('server_event', { foo: 'bar' }, { userId: 'u-1', sessionId: 's-relayed' });
    await sdk.flush();
    const e = ingest.allEvents()[0]!;
    expect(e.kind).toBe('generic');
    expect(e.name).toBe('server_event');
    expect(e.session_id).toBe('s-relayed');
    expect(e.props).toMatchObject({ foo: 'bar' });
    await sdk.shutdown();
  });

  it('R11: the server SDK NEVER emits kind=session across any verb', async () => {
    const { sdk, ingest } = boot();
    sdk.verifiedPurchase(validPurchase);
    sdk.economy({ userId: 'u-1', flowType: 'sink', currencyType: 'gold', amount: 10, reason: 'shop' });
    sdk.track('e', {}, { userId: 'u-1' });
    await sdk.flush();
    for (const e of ingest.allEvents()) {
      expect(e.kind).not.toBe('session');
      expect(SERVER_KINDS).toContain(e.kind);
    }
    await sdk.shutdown();
  });

  it('every emission carries a unique event_id', async () => {
    const { sdk, ingest } = boot();
    sdk.verifiedPurchase(validPurchase);
    sdk.track('e1', {}, { userId: 'u-1' });
    sdk.track('e2', {}, { userId: 'u-1' });
    await sdk.flush();
    const ids = ingest.allEvents().map((e) => e.event_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    await sdk.shutdown();
  });
});
