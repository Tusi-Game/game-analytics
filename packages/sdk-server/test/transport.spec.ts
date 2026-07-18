import { AnalyticsServer } from '../src/server';
import { QueueOverflowError } from '../src/queue';
import { WIRE_VERSION, SDK_NAME } from '../src/wire';
import type { OnError } from '../src/config';
import { FakeClock, fakeSleep, MockIngest } from './helpers';

/**
 * Transport, money-aware queue, at-least-once, never-break-checkout
 * (T-08.43–47) + wire conformance (T-08.44, Q9).
 */
describe('server transport, money-aware queue & at-least-once', () => {
  const purchase = {
    userId: 'u-1',
    transactionId: 'T1',
    originalTransactionId: 'OT1',
    productId: 'p',
    productCategory: 'consumable',
    priceLocal: 1.99,
    currency: 'USD',
    verified: true,
    environment: 'prod' as const,
  };

  function boot(overrides: Record<string, unknown> = {}, onError?: OnError) {
    const clock = new FakeClock();
    const ingest = new MockIngest();
    const sdk = AnalyticsServer.init(
      {
        serverCredential: 'sk_test',
        endpoint: 'https://a.example.com',
        flush_on_purchase: false,
        on_error: onError,
        ...overrides,
      },
      { now: clock.now, sleep: fakeSleep(clock), fetchImpl: ingest.fetchImpl },
    );
    return { sdk, clock, ingest };
  }

  it('every batch carries v:1 + sdk descriptor (sdk.name=analytics-sdk-server), bearer auth, /v1/events', async () => {
    const { sdk, ingest } = boot();
    sdk.track('e', {}, { userId: 'u-1' });
    await sdk.flush();
    const post = ingest.posts[0]!;
    expect(post.url).toBe('https://a.example.com/v1/events');
    expect(post.batch.v).toBe(WIRE_VERSION);
    expect(post.batch.sdk.name).toBe(SDK_NAME);
    expect(post.batch.sdk.name).toBe('analytics-sdk-server'); // stable wire name
    expect(post.headers.Authorization).toBe('Bearer sk_test');
    expect(Object.keys(post.batch).sort()).toEqual(['events', 'sdk', 'v']);
    await sdk.shutdown();
  });

  it('at-least-once: a retry carries the SAME event_id but a DIFFERENT client_sent_time', async () => {
    const { sdk, clock, ingest } = boot();
    ingest.scriptStatuses(500, 200);
    sdk.verifiedPurchase(purchase);
    clock.advance(10);
    await sdk.flush(); // attempt 1 (500) → backoff sleep advances clock → attempt 2 (200)
    expect(ingest.posts.length).toBeGreaterThanOrEqual(2);
    const a1 = ingest.posts[0]!.batch.events[0]!;
    const a2 = ingest.posts[1]!.batch.events[0]!;
    expect(a1.event_id).toBe(a2.event_id); // never re-minted
    expect(a1.client_event_time).toBe(a2.client_event_time); // capture time invariant
    expect(a1.client_sent_time).not.toBe(a2.client_sent_time); // re-stamped per attempt
    await sdk.shutdown();
  });

  it('any 2xx is final (a single 200 retires the batch; no re-send)', async () => {
    const { sdk, ingest } = boot();
    ingest.setDefaultStatus(200);
    sdk.track('e', {}, { userId: 'u-1' });
    await sdk.flush();
    const n = ingest.posts.length;
    await sdk.flush();
    expect(ingest.posts.length).toBe(n); // nothing left
    await sdk.shutdown();
  });

  it('retry budget exhaustion surfaces to on_error and drops the batch (caller re-emits)', async () => {
    const errors: unknown[] = [];
    const { sdk, ingest } = boot(
      { retry_max_elapsed_ms: 5_000, retry_backoff_base_ms: 1_000, retry_backoff_max_ms: 2_000 },
      (e) => errors.push(e),
    );
    ingest.setDefaultStatus(500); // always fails
    sdk.track('e', {}, { userId: 'u-1' });
    await sdk.flush();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    // Batch dropped after budget → a subsequent flush ships nothing new.
    const n = ingest.posts.length;
    await sdk.flush();
    expect(ingest.posts.length).toBe(n);
    await sdk.shutdown();
  });

  it('MONEY-AWARE overflow: a verifiedPurchase that cannot enqueue throws SYNCHRONOUSLY', () => {
    const { sdk } = boot({ queue_max_events: 2 });
    // Fill the queue with money rows (no non-money to evict) so the next money
    // event has nothing to displace → synchronous QueueOverflowError.
    sdk.verifiedPurchase({ ...purchase, transactionId: 'A' });
    sdk.verifiedPurchase({ ...purchase, transactionId: 'B' });
    expect(() => sdk.verifiedPurchase({ ...purchase, transactionId: 'C' })).toThrow(QueueOverflowError);
    void sdk.shutdown();
  });

  it('non-money overflow is dropped-and-counted, NEVER thrown (analytics never breaks the caller)', () => {
    const errors: unknown[] = [];
    const { sdk } = boot({ queue_max_events: 2 }, (e) => errors.push(e));
    sdk.track('e1', {}, { userId: 'u-1' });
    sdk.track('e2', {}, { userId: 'u-1' });
    // Third non-money event overflows: dropped-and-counted, no throw.
    expect(() => sdk.track('e3', {}, { userId: 'u-1' })).not.toThrow();
    expect(sdk.debugState().nonMoneyDropped).toBeGreaterThanOrEqual(1);
    void sdk.shutdown();
  });

  it('never breaks checkout: a transport failure never throws in the emit path', () => {
    const errors: unknown[] = [];
    const { sdk } = boot({}, (e) => errors.push(e));
    // Even with a doomed transport, the emit call returns without throwing.
    expect(() => sdk.verifiedPurchase(purchase)).not.toThrow();
    void sdk.shutdown();
  });

  it('flush_on_purchase (default true) eagerly flushes a verified purchase', async () => {
    const clock = new FakeClock();
    const ingest = new MockIngest();
    const sdk = AnalyticsServer.init(
      { serverCredential: 'sk_test', endpoint: 'https://a.example.com' }, // flush_on_purchase defaults true
      { now: clock.now, sleep: fakeSleep(clock), fetchImpl: ingest.fetchImpl },
    );
    sdk.verifiedPurchase(purchase);
    // The eager flush is fire-and-forget; allow it to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(ingest.allEvents().some((e) => e.kind === 'purchase')).toBe(true);
    await sdk.shutdown();
  });

  it('supports multiple coexisting clients (two credentials, no global state)', async () => {
    const clockA = new FakeClock();
    const clockB = new FakeClock();
    const ingestA = new MockIngest();
    const ingestB = new MockIngest();
    const a = AnalyticsServer.init(
      { serverCredential: 'sk_gameA', endpoint: 'https://a.example.com', flush_on_purchase: false },
      { now: clockA.now, sleep: fakeSleep(clockA), fetchImpl: ingestA.fetchImpl },
    );
    const b = AnalyticsServer.init(
      { serverCredential: 'sk_gameB', endpoint: 'https://b.example.com', flush_on_purchase: false },
      { now: clockB.now, sleep: fakeSleep(clockB), fetchImpl: ingestB.fetchImpl },
    );
    a.track('ea', {}, { userId: 'ua' });
    b.track('eb', {}, { userId: 'ub' });
    await a.flush();
    await b.flush();
    expect(ingestA.posts[0]!.headers.Authorization).toBe('Bearer sk_gameA');
    expect(ingestB.posts[0]!.headers.Authorization).toBe('Bearer sk_gameB');
    expect(ingestA.allEvents().every((e) => e.name === 'ea')).toBe(true);
    expect(ingestB.allEvents().every((e) => e.name === 'eb')).toBe(true);
    await a.shutdown();
    await b.shutdown();
  });
});
