import { loadGoldenStream, goldenExpectations } from '../../fixtures';

/**
 * Shared golden-fixture loader (R4). Proves the loader strips the `_fixture`
 * annotation (so envelopes are clean wire objects) and surfaces the expected
 * verdicts. This is the ONE physical fixture set 002/008/009 co-own.
 */

describe('golden envelope-stream fixtures (R4)', () => {
  it('loads a clean batch with no _fixture annotation leaking into envelopes', () => {
    const batch = loadGoldenStream();
    expect(batch.events.length).toBeGreaterThan(0);
    for (const event of batch.events) {
      expect((event as unknown as Record<string, unknown>)._fixture).toBeUndefined();
      expect(typeof event.event_id).toBe('string');
      expect(typeof event.name).toBe('string');
    }
  });

  it('surfaces per-event expectations covering the U3 verdict matrix', () => {
    const exp = goldenExpectations();
    const verdicts = new Set(exp.map((e) => e.expect.verdict));
    // The stream exercises every disposition + the duplicate case.
    expect(verdicts).toEqual(new Set(['route', 'route-duplicate', 'quarantine', 'drop']));
    // Specific dark-spot cases are present.
    expect(exp.some((e) => e.expect.case === 'reserved-name-override-invalid')).toBe(true);
    expect(exp.some((e) => e.expect.case === 'trust-boundary-isolation')).toBe(true);
    expect(exp.some((e) => e.expect.reason === 'nameless')).toBe(true);
    expect(exp.some((e) => e.expect.reason === 'quarantined_typed')).toBe(true);
  });
});
