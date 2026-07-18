import { AnalyticsClient } from '../src/client';
import { createStorage } from '../src/storage';
import { WIRE_VERSION, SDK_NAME } from '../src/wire';
import { FakeClock, FakeTimers, MockIngest, makeHooks } from './helpers';

/**
 * Transport, offline queue, at-least-once (T-08.30–36) + wire conformance
 * (T-08.9/10/35/57).
 */
describe('client transport & at-least-once', () => {
  async function boot(overrides: Record<string, unknown> = {}) {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const ingest = new MockIngest();
    // Memory storage → deterministic queue accounting for the transport contracts.
    const storage = await createStorage('memory');
    const hooks = { ...makeHooks(clock, timers, ingest), storage };
    const sdk = await AnalyticsClient.init(
      { sdkKey: 'pk_test', endpoint: 'https://a.example.com', ...overrides },
      hooks,
    );
    return { sdk, clock, timers, ingest };
  }

  it('every batch carries explicit v:1 + the sdk descriptor, bearer auth, /v1/events', async () => {
    const { sdk, ingest } = await boot();
    await sdk.track('e');
    await sdk.flush();
    const post = ingest.posts[0]!;
    expect(post.url).toBe('https://a.example.com/v1/events');
    expect(post.batch.v).toBe(WIRE_VERSION);
    expect(post.batch.sdk.name).toBe(SDK_NAME);
    expect(typeof post.batch.sdk.version).toBe('string');
    expect(post.headers.Authorization).toBe('Bearer pk_test');
    // No top-level batch field outside {v, sdk, events}.
    expect(Object.keys(post.batch).sort()).toEqual(['events', 'sdk', 'v']);
    sdk.dispose();
  });

  it('removes events only on 2xx; retries on 5xx keep them queued', async () => {
    const { sdk, ingest } = await boot();
    ingest.scriptStatuses(500, 500, 200); // fail twice, then succeed
    await sdk.track('e');
    await sdk.flush(); // 500
    await sdk.flush(); // 500
    await sdk.flush(); // 200
    // The same single event appears in all three POSTs (retained until 2xx).
    expect(ingest.posts).toHaveLength(3);
    const remaining = sdk.debugState();
    void remaining;
    // A fourth flush ships nothing (queue drained after the 2xx).
    await sdk.flush();
    expect(ingest.posts).toHaveLength(3);
    sdk.dispose();
  });

  it('at-least-once: a retry carries the SAME event_id but a DIFFERENT client_sent_time', async () => {
    const { sdk, clock, ingest } = await boot();
    ingest.scriptStatuses(500, 200);
    await sdk.track('e');
    const captureWall = clock.now();
    clock.advance(1000);
    await sdk.flush(); // attempt 1 (500)
    clock.advance(5000);
    await sdk.flush(); // attempt 2 (200)

    const a1 = ingest.posts[0]!.batch.events[0]!;
    const a2 = ingest.posts[1]!.batch.events[0]!;
    expect(a1.event_id).toBe(a2.event_id); // event_id NEVER re-minted
    expect(a1.client_event_time).toBe(a2.client_event_time); // capture time invariant
    expect(a1.client_event_time).toBe(captureWall);
    expect(a1.client_sent_time).not.toBe(a2.client_sent_time); // re-stamped per attempt
    expect(a2.client_sent_time!).toBeGreaterThan(a1.client_sent_time!);
    sdk.dispose();
  });

  it('2xx-quarantine and 2xx-count are indistinguishable (Q9): both retire the batch', async () => {
    const { sdk, ingest } = await boot();
    ingest.setDefaultStatus(200); // could be quarantine OR count — SDK cannot tell
    await sdk.track('e1');
    await sdk.flush();
    const afterFirst = ingest.posts.length;
    await sdk.flush(); // nothing left to send
    expect(ingest.posts.length).toBe(afterFirst);
    sdk.dispose();
  });

  it('drop-and-debug on a non-auth 4xx (unrecoverable); no infinite retry', async () => {
    const { sdk, ingest } = await boot();
    ingest.setDefaultStatus(400);
    await sdk.track('e');
    await sdk.flush(); // 400 → drop
    const posts1 = ingest.posts.length;
    await sdk.flush(); // nothing left (dropped)
    expect(ingest.posts.length).toBe(posts1);
    sdk.dispose();
  });

  it('401 pauses transport, keeps queueing, and does not silently drop', async () => {
    const { sdk, ingest } = await boot();
    ingest.setDefaultStatus(401);
    await sdk.track('e1');
    await sdk.flush(); // 401 → pause
    expect(sdk.debugState().transportPaused).toBe(true);
    await sdk.track('e2'); // still queues
    await sdk.flush(); // paused: no new POST
    expect(ingest.posts).toHaveLength(1);
    sdk.dispose();
  });

  it('client-side TTL drops non-money events older than event_ttl_ms before send', async () => {
    const { sdk, clock, ingest } = await boot({ event_ttl_ms: 60_000 }); // 1-min TTL
    await sdk.track('stale');
    clock.advance(120_000); // age past the TTL
    await sdk.flush();
    expect(ingest.allEvents()).toHaveLength(0); // dropped before send
    expect(sdk.debugState().queue.ttlDropped).toBeGreaterThanOrEqual(1);
    sdk.dispose();
  });

  it('money (purchase companion) is TTL-EXEMPT', async () => {
    const { sdk, clock, ingest } = await boot({ event_ttl_ms: 60_000 });
    const attempt = sdk.newPurchaseAttempt();
    await sdk.purchaseContext(attempt);
    clock.advance(120_000);
    await sdk.flush();
    // Companion still ships despite being older than the TTL (money exempt).
    expect(ingest.allEvents().filter((e) => e.kind === 'purchase')).toHaveLength(1);
    sdk.dispose();
  });

  it('bounded queue drops OLDEST at the cap with a visible overflow count', async () => {
    // 100 is the configured minimum for offline_queue_max_events (spec §6 range).
    const { sdk, ingest } = await boot({ offline_queue_max_events: 100 });
    ingest.setDefaultStatus(500); // never drains — force accumulation at the cap
    for (let i = 0; i < 105; i++) await sdk.track(`e${i}`);
    expect(sdk.debugState().queue.overflowDropped).toBeGreaterThanOrEqual(5);
    sdk.dispose();
  });

  it('byte-splits an oversized backlog into multiple POSTs', async () => {
    const { sdk, ingest } = await boot({ batch_max_bytes: 800, batch_max_events: 100 });
    for (let i = 0; i < 20; i++) await sdk.track(`e${i}`, { pad: 'x'.repeat(80) });
    await sdk.flush();
    expect(ingest.posts.length).toBeGreaterThan(1); // split occurred
    sdk.dispose();
  });

  it('queue survives a simulated restart (persistent storage)', async () => {
    const storage = await createStorage('memory');
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const ingest1 = new MockIngest();
    ingest1.setDefaultStatus(500); // never acked in run 1
    const sdk1 = await AnalyticsClient.init(
      { sdkKey: 'pk_test', endpoint: 'https://a.example.com' },
      {
        now: clock.now,
        monotonic: clock.monotonic,
        timers: { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
        fetchImpl: ingest1.fetchImpl,
        storage,
      },
    );
    await sdk1.track('survivor');
    await sdk1.flush(); // 500 → stays queued
    sdk1.dispose();

    const ingest2 = new MockIngest(); // run 2 acks
    const sdk2 = await AnalyticsClient.init(
      { sdkKey: 'pk_test', endpoint: 'https://a.example.com' },
      {
        now: clock.now,
        monotonic: clock.monotonic,
        timers: { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
        fetchImpl: ingest2.fetchImpl,
        storage,
      },
    );
    await sdk2.flush();
    expect(ingest2.allEvents().some((e) => e.name === 'survivor')).toBe(true);
    sdk2.dispose();
  });
});
