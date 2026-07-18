import { AnalyticsClient } from '../src/client';
import { LocalValidationError } from '../src/validation';
import { ALLOWED_ENVELOPE_KEYS } from '../src/wire';
import { FakeClock, FakeTimers, MockIngest, makeHooks } from './helpers';

/**
 * Capture verbs → envelope conformance (T-08.14/24/25/27/28), the companion
 * zero-money invariant (P5, FR-021), and local validation (T-08.15).
 */
describe('client capture verbs & envelope conformance', () => {
  async function boot() {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const ingest = new MockIngest();
    const sdk = await AnalyticsClient.init(
      { sdkKey: 'pk_test', endpoint: 'https://a.example.com/', debug: false },
      makeHooks(clock, timers, ingest),
    );
    return { sdk, clock, timers, ingest };
  }

  it('track emits one generic envelope with no game_id / server_received_time / client_sent_time', async () => {
    const { sdk, ingest } = await boot();
    await sdk.track('level_start', { level: 3 });
    await sdk.flush();
    const events = ingest.allEvents();
    expect(events).toHaveLength(1);
    const e = events[0]! as Record<string, unknown>;
    expect(e.name).toBe('level_start');
    expect(e.kind).toBe('generic');
    expect(e.props).toEqual({ level: 3 });
    expect(e.anon_id).toBeDefined();
    expect(e.session_id).toBeDefined();
    expect(e.event_id).toBeDefined();
    // P12: never send game_id / server_received_time.
    expect(e).not.toHaveProperty('game_id');
    expect(e).not.toHaveProperty('server_received_time');
    // client_sent_time IS stamped at flush (present on the wire, not at capture).
    expect(typeof e.client_sent_time).toBe('number');
    // Only the allowed top-level keys plus client_sent_time appear.
    const allowed = new Set<string>([...ALLOWED_ENVELOPE_KEYS]);
    for (const key of Object.keys(e)) expect(allowed.has(key)).toBe(true);
    sdk.dispose();
  });

  it('economy validates amount>0 and flow_type; rejects invalid at the call site', async () => {
    const { sdk, ingest } = await boot();
    await expect(sdk.economy('sink', 'gold', -5, 'r')).rejects.toBeInstanceOf(LocalValidationError);
    await expect(sdk.economy('bogus' as never, 'gold', 5, 'r')).rejects.toBeInstanceOf(LocalValidationError);
    await sdk.economy('sink', 'gold', 50, 'shop', { balance_after: 120 });
    await sdk.flush();
    const events = ingest.allEvents();
    expect(events).toHaveLength(1); // only the valid one shipped
    const p = (events[0]! as { props: Record<string, unknown> }).props;
    expect(p).toMatchObject({
      flow_type: 'sink',
      currency_type: 'gold',
      amount: 50,
      reason: 'shop',
      balance_after: 120,
    });
    sdk.dispose();
  });

  it('purchaseContext companion carries purchase_attempt_id + ZERO money + source=client', async () => {
    const { sdk, ingest } = await boot();
    const attemptId = sdk.newPurchaseAttempt();
    expect(typeof attemptId).toBe('string');
    await sdk.purchaseContext(attemptId, { player_level: 12, region: 'EU', in_game_state: 'pre_boss' });
    await sdk.flush();
    const e = ingest.allEvents()[0]! as { kind: string; props: Record<string, unknown> };
    expect(e.kind).toBe('purchase');
    expect(e.props.purchase_attempt_id).toBe(attemptId);
    expect(e.props.source).toBe('client');
    expect(e.props.sessions_before_purchase).toBe(1);
    expect(e.props.days_since_install).toBe(0);
    // ZERO money: no money-bearing keys EVER on the companion.
    for (const moneyKey of [
      'price_local',
      'currency',
      'verified',
      'amount',
      'normalized_amount',
      'revenue',
      'transaction_id',
    ]) {
      expect(e.props).not.toHaveProperty(moneyKey);
    }
    sdk.dispose();
  });

  it('purchaseContext rejects a missing purchase_attempt_id', async () => {
    const { sdk } = await boot();
    await expect(sdk.purchaseContext('')).rejects.toBeInstanceOf(LocalValidationError);
    sdk.dispose();
  });

  it('track rejects an empty name locally (never ships a nameless drop)', async () => {
    const { sdk, ingest } = await boot();
    await expect(sdk.track('   ')).rejects.toBeInstanceOf(LocalValidationError);
    await sdk.flush();
    expect(ingest.allEvents()).toHaveLength(0);
    sdk.dispose();
  });

  it('identify emits a one-off alias edge on the first anon→user transition', async () => {
    const { sdk, ingest } = await boot();
    await sdk.identify('u-1');
    await sdk.identify('u-1'); // second call: NO new alias edge
    await sdk.track('after_identify');
    await sdk.flush();
    const events = ingest.allEvents();
    const aliases = events.filter((e) => e.name === 'identify');
    expect(aliases).toHaveLength(1);
    const alias = aliases[0]! as { props: Record<string, unknown> };
    expect(alias.props.alias).toMatchObject({ user_id: 'u-1' });
    // subsequent captures carry user_id
    const after = events.find((e) => e.name === 'after_identify') as { user_id?: string };
    expect(after.user_id).toBe('u-1');
    sdk.dispose();
  });
});
