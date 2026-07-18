import { goldenVerifiedPurchases } from '../../../fixtures';
import { AnalyticsServer } from '../src/server';
import type { VerifiedPurchaseInput } from '../src/server';
import { FakeClock, fakeSleep, MockIngest } from './helpers';

/**
 * R4 shared-fixture conformance (T-08.54) + bridge 05.5 SDK-side (verified=false
 * / sandbox consume no slot; parked-FX purchase still ships). The server's live
 * output SHAPE must match the golden verified-purchase fixtures the ingest /
 * monetization tests also read. event_id is a static placeholder → assert
 * SHAPE + field-names + forbidden-key ABSENCE, not the minted id.
 */
describe('R4 server conformance against shared golden verified-purchase fixtures', () => {
  function boot() {
    const clock = new FakeClock();
    const ingest = new MockIngest();
    const sdk = AnalyticsServer.init(
      { serverCredential: 'sk_test', endpoint: 'https://a.example.com', flush_on_purchase: false },
      { now: clock.now, sleep: fakeSleep(clock), fetchImpl: ingest.fetchImpl },
    );
    return { sdk, ingest };
  }

  /** Map a fixture `input` record to the typed verifiedPurchase input. */
  function toInput(raw: Record<string, unknown>): VerifiedPurchaseInput {
    return {
      userId: raw.userId as string,
      transactionId: raw.transactionId as string,
      originalTransactionId: raw.originalTransactionId as string,
      productId: raw.productId as string,
      productCategory: raw.productCategory as string,
      priceLocal: raw.priceLocal as number,
      currency: raw.currency as string,
      verified: raw.verified as boolean,
      environment: raw.environment as 'prod' | 'sandbox',
      purchaseAttemptId: raw.purchaseAttemptId as string | undefined,
      refunded: raw.refunded as boolean | undefined,
    };
  }

  it('the golden verified-purchase fixture set is loadable and non-trivial', () => {
    const golden = goldenVerifiedPurchases();
    expect(golden.length).toBeGreaterThanOrEqual(3);
  });

  it('every golden case: SDK output matches shape + field-names, forbidden keys ABSENT', async () => {
    for (const g of goldenVerifiedPurchases()) {
      const { sdk, ingest } = boot();
      sdk.verifiedPurchase(toInput(g.input));
      await sdk.flush();
      const live = ingest.allEvents()[0]!;

      // Top-level: same key set as the golden envelope, no forbidden keys.
      const liveTop = Object.keys(live)
        .filter((k) => k !== 'client_sent_time')
        .sort();
      const goldenTop = Object.keys(g.envelope).sort();
      expect(liveTop).toEqual(goldenTop);
      for (const forbidden of g.forbidden_top_level_keys) {
        expect(live).not.toHaveProperty(forbidden);
      }

      // props: exact match on the [006 §3] field set (id-free), no forbidden props.
      const goldProps = g.envelope.props as Record<string, unknown>;
      expect(live.props).toMatchObject(goldProps);
      expect(Object.keys(live.props).sort()).toEqual(Object.keys(goldProps).sort());
      for (const forbidden of g.forbidden_prop_keys) {
        expect(live.props).not.toHaveProperty(forbidden);
      }

      await sdk.shutdown();
    }
  });

  it('bridge 05.5: verified=false and sandbox rows still ship one conformant envelope (accepted-but-ineligible)', async () => {
    const golden = goldenVerifiedPurchases();
    const falseCase = golden.find((g) => g.case === 'verified-false-consumes-no-slot')!;
    const sandboxCase = golden.find((g) => g.case === 'sandbox-accepted-ineligible')!;
    for (const g of [falseCase, sandboxCase]) {
      const { sdk, ingest } = boot();
      sdk.verifiedPurchase(toInput(g.input));
      await sdk.flush();
      const purchases = ingest.allEvents().filter((e) => e.kind === 'purchase');
      expect(purchases).toHaveLength(1); // the SDK ships it; eligibility is the server's gate
      await sdk.shutdown();
    }
  });

  it('bridge 05.5: a duplicate emission (same transaction_id) produces two identical-txn wire rows (server dedups, not SDK)', async () => {
    const golden = goldenVerifiedPurchases()[0]!;
    const { sdk, ingest } = boot();
    sdk.verifiedPurchase(toInput(golden.input));
    sdk.verifiedPurchase(toInput(golden.input)); // crash-simulated re-emit
    await sdk.flush();
    const purchases = ingest.allEvents().filter((e) => e.kind === 'purchase');
    expect(purchases).toHaveLength(2);
    expect(purchases[0]!.props.transaction_id).toBe(purchases[1]!.props.transaction_id);
    // Distinct event_ids — the windowed gate would see them as separate events,
    // the durable transaction_id gate collapses them (server-side, not here).
    expect(purchases[0]!.event_id).not.toBe(purchases[1]!.event_id);
    await sdk.shutdown();
  });
});
