import { EXCEPTION_REASONS, isExceptionReason } from './exception-reason';

/**
 * R5: the exception-reason enum is declared ONCE. This test pins the full v1
 * set of 12 so an accidental drop/rename is caught, and exercises the runtime
 * guard.
 */
describe('ExceptionReason (R5, foundation §1.2)', () => {
  it('declares exactly the 12 v1 reasons', () => {
    expect([...EXCEPTION_REASONS]).toEqual([
      'nameless',
      'unparseable',
      'capexceeded',
      'quarantined_typed',
      'sealed_late',
      'time_fallback',
      'negative_offset',
      'no_spine_row',
      'unknown_kind',
      'fx_stale_rate_used',
      'fx_unconverted',
      'rate_limited',
    ]);
    expect(new Set(EXCEPTION_REASONS).size).toBe(12);
  });

  it('narrows an unknown via the runtime guard', () => {
    expect(isExceptionReason('rate_limited')).toBe(true);
    expect(isExceptionReason('nope')).toBe(false);
    expect(isExceptionReason(42)).toBe(false);
    expect(isExceptionReason(undefined)).toBe(false);
  });
});
