import { createStorage } from '../src/storage';
import { AnalyticsClient } from '../src/client';
import { FakeClock, FakeTimers, MockIngest } from './helpers';

/**
 * Storage adapter (T-08.12): `auto` prefers IndexedDB (fake-indexeddb is
 * installed by the jest setup), never-throw on failure, memory fallback.
 */
describe('client storage adapter', () => {
  it('auto selects IndexedDB when available (fake-indexeddb)', async () => {
    const s = await createStorage('auto');
    expect(s.backend).toBe('indexeddb');
  });

  it('memory mode is explicit and functional', async () => {
    const s = await createStorage('memory');
    expect(s.backend).toBe('memory');
    await s.setItem('k', 'v');
    expect(await s.getItem('k')).toBe('v');
  });

  it('IndexedDB queue round-trips push/peek/remove with drop-oldest at cap', async () => {
    const s = await createStorage('indexeddb');
    const mk = (n: number) => ({
      envelope: { event_id: `e${n}`, name: 'x', kind: 'generic', client_event_time: n, props: {} } as never,
      enqueued_at: n,
      money: false,
    });
    for (let i = 0; i < 5; i++) await s.push(mk(i), 3); // cap 3 → drops oldest
    const rows = await s.peek(10);
    expect(rows.length).toBe(3);
    // oldest (e0, e1) evicted; newest retained.
    const ids = rows.map((r) => (r.envelope as { event_id: string }).event_id);
    expect(ids).toContain('e4');
    expect(ids).not.toContain('e0');
    await s.remove([rows[0]!.seq]);
    expect((await s.peek(10)).length).toBe(2);
  });

  it('persists across a fresh adapter instance (same IndexedDB db)', async () => {
    const s1 = await createStorage('indexeddb');
    await s1.setItem('anon_id', 'persisted-anon');
    const s2 = await createStorage('indexeddb');
    expect(await s2.getItem('anon_id')).toBe('persisted-anon');
  });

  it('unload flush uses keepalive fetch and ships the queue tail', async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const ingest = new MockIngest();
    const sdk = await AnalyticsClient.init(
      { sdkKey: 'pk_test', endpoint: 'https://a.example.com', storage: 'memory' },
      {
        now: clock.now,
        monotonic: clock.monotonic,
        timers: { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
        fetchImpl: ingest.fetchImpl,
      },
    );
    await sdk.track('a');
    await sdk.track('b');
    // Simulate the browser hiding the tab.
    document.dispatchEvent(new Event('visibilitychange'));
    // visibilityState defaults to 'visible' in jsdom; force hidden + re-dispatch.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 10));
    const keepalivePosts = ingest.posts.filter((p) => p.keepalive);
    expect(keepalivePosts.length).toBeGreaterThanOrEqual(1);
    sdk.dispose();
  });
});
