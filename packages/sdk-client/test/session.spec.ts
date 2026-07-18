import { AnalyticsClient } from '../src/client';
import { createStorage } from '../src/storage';
import { FakeClock, FakeTimers, MockIngest, makeHooks, settle } from './helpers';

/**
 * Session tracker — the [003-sessions §1] executor (T-08.16–20) and the bridge
 * 02.5 SDK-side halves: exactly ONE terminal per session, reconciled close
 * carries the ORIGINAL start time, session_id opaque + never reused.
 */
describe('client session lifecycle', () => {
  const TIMEOUT_MIN = 30;
  const TIMEOUT_MS = TIMEOUT_MIN * 60_000;

  async function boot() {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const ingest = new MockIngest();
    // Memory storage → deterministic, synchronous-ish; timer-driven terminal
    // events settle without IndexedDB's extra async hops.
    const storage = await createStorage('memory');
    const hooks = { ...makeHooks(clock, timers, ingest), storage };
    const sdk = await AnalyticsClient.init({ sdkKey: 'pk_test', endpoint: 'https://a.example.com' }, hooks);
    return { sdk, clock, timers, ingest };
  }

  it('starts lazily: init alone emits no session; first capture mints one', async () => {
    const { sdk, ingest } = await boot();
    await sdk.flush();
    expect(ingest.allEvents().filter((e) => e.kind === 'session')).toHaveLength(0);
    await sdk.track('first');
    await sdk.flush();
    const first = ingest.allEvents().find((e) => e.name === 'first') as { session_id?: string };
    expect(first.session_id).toBeDefined();
    sdk.dispose();
  });

  it('emits exactly ONE terminal session on inactivity timeout, end = true last_activity', async () => {
    const { sdk, clock, timers, ingest } = await boot();
    await sdk.track('a'); // starts session at t0
    const startWall = clock.now();
    clock.advance(5 * 60_000); // 5 min later
    await sdk.track('b'); // last_activity = t0+5min
    const lastActivity = clock.now();
    clock.advance(TIMEOUT_MS); // idle past the timeout
    timers.runDue(); // fire the inactivity timer
    await settle();
    await sdk.flush();

    const terminals = ingest.allEvents().filter((e) => e.kind === 'session');
    expect(terminals).toHaveLength(1);
    const t = terminals[0]! as { props: Record<string, number | string> };
    expect(t.props.reason).toBe('timeout');
    expect(t.props.session_start_time).toBe(startWall);
    // end = true last_activity, NOT inflated to last_activity + timeout.
    expect(t.props.session_end_time).toBe(lastActivity);
    expect(t.props.duration_ms).toBe(lastActivity - startWall);
    sdk.dispose();
  });

  it('monotonic timer: a wall-clock jump never spuriously splits a session', async () => {
    const { sdk, clock, timers, ingest } = await boot();
    await sdk.track('a');
    clock.advanceWallOnly(60 * 60_000); // wall jumps forward 1h; monotonic unchanged
    timers.runDue(); // any timer that fires must NOT close (elapsed monotonic ~0)
    await Promise.resolve();
    await sdk.track('b');
    await sdk.flush();
    const terminals = ingest.allEvents().filter((e) => e.kind === 'session');
    expect(terminals).toHaveLength(0); // no split
    const a = ingest.allEvents().find((e) => e.name === 'a') as { session_id: string };
    const b = ingest.allEvents().find((e) => e.name === 'b') as { session_id: string };
    expect(a.session_id).toBe(b.session_id); // same session across the wall jump
    sdk.dispose();
  });

  it('a NEW session after expiry mints a fresh, non-reused session_id', async () => {
    const { sdk, clock, timers, ingest } = await boot();
    await sdk.track('s1a');
    const s1 = (ingest.allEvents(), undefined);
    void s1;
    clock.advance(TIMEOUT_MS + 1000);
    timers.runDue();
    await settle();
    await sdk.track('s2a'); // starts a fresh session
    await sdk.flush();
    const s1id = (ingest.allEvents().find((e) => e.name === 's1a') as { session_id: string }).session_id;
    const s2id = (ingest.allEvents().find((e) => e.name === 's2a') as { session_id: string }).session_id;
    expect(s1id).not.toBe(s2id);
    sdk.dispose();
  });

  it('reconcile-at-init: a persisted open session is closed with reason=reconciled + ORIGINAL start', async () => {
    // Shared storage across two "app runs".
    const storage = await createStorage('memory');
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const ingest1 = new MockIngest();
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
    await sdk1.track('run1'); // opens a session, persists the open-session record
    const startWall = clock.now();
    clock.advance(2 * 60_000);
    await sdk1.track('run1b'); // last_activity = start + 2min
    const lastActivity = clock.now();
    sdk1.dispose(); // simulate a KILL before the terminal event was ever emitted

    // Second run reuses the same storage → reconcile fires at init.
    const ingest2 = new MockIngest();
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
    const terminals = ingest2.allEvents().filter((e) => e.kind === 'session');
    expect(terminals).toHaveLength(1);
    const t = terminals[0]! as { props: Record<string, number | string> };
    expect(t.props.reason).toBe('reconciled');
    expect(t.props.session_start_time).toBe(startWall); // ORIGINAL start
    expect(t.props.session_end_time).toBe(lastActivity); // persisted last_activity
    sdk2.dispose();
  });

  it('appClose emits a single terminal session (reason=app_close)', async () => {
    const { sdk, ingest } = await boot();
    await sdk.track('a');
    await sdk.appClose();
    await sdk.flush();
    const terminals = ingest.allEvents().filter((e) => e.kind === 'session');
    expect(terminals).toHaveLength(1);
    expect((terminals[0]! as { props: { reason: string } }).props.reason).toBe('app_close');
    sdk.dispose();
  });
});
