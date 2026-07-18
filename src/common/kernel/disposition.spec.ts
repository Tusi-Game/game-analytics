import {
  dropVerdict,
  quarantineVerdict,
  routeVerdict,
  dispositionForReason,
  isDropReason,
  isQuarantineReason,
} from './disposition';

/**
 * Drop-vs-quarantine (foundation §4.4), RECONCILED to R3: cardinality caps
 * OVERFLOW to `other` (kept + counted) — they do NOT drop. `capexceeded` must
 * never reach this helper as a drop.
 */
describe('disposition (foundation §4.4, R3-reconciled)', () => {
  it('nameless / unparseable / rate_limited are DROP reasons', () => {
    expect(isDropReason('nameless')).toBe(true);
    expect(isDropReason('unparseable')).toBe(true);
    expect(isDropReason('rate_limited')).toBe(true);
    expect(dispositionForReason('nameless')).toBe('drop');
    expect(dispositionForReason('unparseable')).toBe('drop');
    expect(dispositionForReason('rate_limited')).toBe('drop');
  });

  it('typed-invalid / sealed-late / unknown_kind / time_fallback are QUARANTINE reasons', () => {
    expect(isQuarantineReason('quarantined_typed')).toBe(true);
    expect(isQuarantineReason('sealed_late')).toBe(true);
    expect(isQuarantineReason('unknown_kind')).toBe(true);
    expect(isQuarantineReason('time_fallback')).toBe(true);
    expect(dispositionForReason('quarantined_typed')).toBe('quarantine');
    expect(dispositionForReason('sealed_late')).toBe('quarantine');
    expect(dispositionForReason('unknown_kind')).toBe('quarantine');
  });

  it('R3: capexceeded is NEITHER a drop NOR a quarantine reason — it overflows to `other` upstream', () => {
    expect(isDropReason('capexceeded')).toBe(false);
    expect(isQuarantineReason('capexceeded')).toBe(false);
    // Reaching this helper with capexceeded is a programming error (a cap ROUTES).
    expect(() => dispositionForReason('capexceeded')).toThrow(/overflows to the `other`/);
  });

  it('verdict builders stamp the right disposition + reason', () => {
    expect(dropVerdict('nameless')).toEqual({
      dedup_passed: false,
      seal_state: 'open',
      disposition: 'drop',
      reason: 'nameless',
    });
    expect(quarantineVerdict('sealed_late', 'sealed')).toEqual({
      dedup_passed: false,
      seal_state: 'sealed',
      disposition: 'quarantine',
      reason: 'sealed_late',
    });
    expect(routeVerdict('open', true)).toEqual({
      dedup_passed: true,
      seal_state: 'open',
      disposition: 'route',
    });
  });
});
