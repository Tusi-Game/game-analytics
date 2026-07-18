import { goldenClientEmissions } from '../../../fixtures';
import { AnalyticsClient } from '../src/client';
import { FakeClock, FakeTimers, MockIngest, makeHooks } from './helpers';

/**
 * R4 shared-fixture conformance (T-08.53). The SDK's live output SHAPE must match
 * the golden emissions the ingest tests also read. Ids are static placeholders in
 * the fixtures, so we assert SHAPE + field-names + the fixed non-id props — never
 * the exact minted ids.
 */
describe('R4 client conformance against shared golden fixtures', () => {
  it('the golden fixture set is loadable and non-trivial', () => {
    const emissions = goldenClientEmissions();
    expect(emissions.length).toBeGreaterThanOrEqual(5);
    for (const e of emissions) {
      // Every golden envelope is Foundation §1.1-shaped and NEVER carries game_id.
      expect(e.envelope).not.toHaveProperty('game_id');
      expect(e.envelope).not.toHaveProperty('server_received_time');
      expect(typeof e.envelope.name).toBe('string');
      expect(typeof e.envelope.kind).toBe('string');
    }
  });

  async function boot() {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const ingest = new MockIngest();
    const sdk = await AnalyticsClient.init(
      { sdkKey: 'pk_test', endpoint: 'https://a.example.com' },
      makeHooks(clock, timers, ingest),
    );
    return { sdk, ingest };
  }

  /** Compare live output to a golden envelope on field-NAMES + non-id fields. */
  function assertShapeMatches(live: Record<string, unknown>, golden: Record<string, unknown>): void {
    const idKeys = new Set(['event_id', 'session_id', 'anon_id', 'client_event_time', 'client_sent_time']);
    // Same top-level key set (minus flush-stamped client_sent_time on live).
    const liveKeys = Object.keys(live)
      .filter((k) => k !== 'client_sent_time')
      .sort();
    const goldenKeys = Object.keys(golden).sort();
    expect(liveKeys).toEqual(goldenKeys);
    // Non-id fields match value-for-value.
    for (const key of goldenKeys) {
      if (idKeys.has(key)) continue;
      expect(live[key]).toEqual(golden[key]);
    }
  }

  it('track output matches the golden generic emission (shape + names)', async () => {
    const golden = goldenClientEmissions().find((e) => e.case === 'track-generic')!;
    const { sdk, ingest } = await boot();
    await sdk.track('level_start', { level: 3 });
    await sdk.flush();
    assertShapeMatches(
      ingest.allEvents()[0]! as Record<string, unknown>,
      golden.envelope as unknown as Record<string, unknown>,
    );
    sdk.dispose();
  });

  it('economy output matches the golden economy emission', async () => {
    const golden = goldenClientEmissions().find((e) => e.case === 'economy-client-provenance')!;
    const { sdk, ingest } = await boot();
    await sdk.economy('sink', 'gold', 50, 'shop_purchase', { balance_after: 120 });
    await sdk.flush();
    assertShapeMatches(
      ingest.allEvents()[0]! as Record<string, unknown>,
      golden.envelope as unknown as Record<string, unknown>,
    );
    sdk.dispose();
  });

  it('purchase companion output matches the golden zero-money companion', async () => {
    const golden = goldenClientEmissions().find((e) => e.case === 'purchase-companion-zero-money')!;
    const { sdk, ingest } = await boot();
    const attempt = sdk.newPurchaseAttempt();
    await sdk.purchaseContext(attempt, { player_level: 12, region: 'EU', in_game_state: 'pre_boss' });
    await sdk.flush();
    const live = ingest.allEvents()[0]! as Record<string, unknown>;
    // purchase_attempt_id is a minted id in live → treat it as an id field.
    const liveProps = { ...(live.props as Record<string, unknown>) };
    const goldProps = { ...(golden.envelope.props as Record<string, unknown>) };
    delete liveProps.purchase_attempt_id;
    delete goldProps.purchase_attempt_id;
    expect(Object.keys(liveProps).sort()).toEqual(Object.keys(goldProps).sort());
    expect(liveProps).toMatchObject(goldProps);
    expect(live.kind).toBe('purchase');
    sdk.dispose();
  });
});
