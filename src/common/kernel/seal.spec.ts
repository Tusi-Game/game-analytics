import { checkSealState, isMutable, DEFAULT_GRACE_WINDOW_MS } from './seal';

/**
 * Seal check (foundation §2.3, §4.3). The seal clock is D_end + 48h grace, and
 * D_end is offset-shifted the SAME as the day floor (DARK-SPOT #4 part b).
 */
describe('checkSealState (foundation §2.3, §4.3)', () => {
  const ms = (iso: string): number => Date.parse(iso);
  const TEHRAN = 210; // +03:30

  const eventTime = ms('2026-07-18T12:00:00Z');

  describe('offset 0 (UTC)', () => {
    // D = 2026-07-18 UTC. D_end = 2026-07-19T00:00Z. seal at +48h = 2026-07-21T00:00Z.
    it('open before D_end', () => {
      expect(
        checkSealState({ correctedTime: eventTime, now: ms('2026-07-18T23:00:00Z'), reportingOffsetMinutes: 0 }),
      ).toBe('open');
    });
    it('grace between D_end and D_end+48h', () => {
      expect(
        checkSealState({ correctedTime: eventTime, now: ms('2026-07-20T12:00:00Z'), reportingOffsetMinutes: 0 }),
      ).toBe('grace');
    });
    it('sealed at/after D_end+48h', () => {
      expect(
        checkSealState({ correctedTime: eventTime, now: ms('2026-07-21T00:00:00Z'), reportingOffsetMinutes: 0 }),
      ).toBe('sealed');
    });
  });

  describe('+3:30 — the seal clock is shifted the SAME as the day floor', () => {
    // D = local 2026-07-18. D_end = local midnight of the 19th = 2026-07-18T20:30Z.
    // seal at D_end + 48h = 2026-07-20T20:30Z.
    const dEnd = ms('2026-07-18T20:30:00Z');
    const sealAt = dEnd + DEFAULT_GRACE_WINDOW_MS;

    it('open just before the shifted D_end', () => {
      expect(checkSealState({ correctedTime: eventTime, now: dEnd - 1, reportingOffsetMinutes: TEHRAN })).toBe('open');
    });
    it('grace exactly at the shifted D_end', () => {
      expect(checkSealState({ correctedTime: eventTime, now: dEnd, reportingOffsetMinutes: TEHRAN })).toBe('grace');
    });
    it('grace just before the shifted seal instant', () => {
      expect(checkSealState({ correctedTime: eventTime, now: sealAt - 1, reportingOffsetMinutes: TEHRAN })).toBe(
        'grace',
      );
    });
    it('sealed exactly at the shifted seal instant', () => {
      expect(checkSealState({ correctedTime: eventTime, now: sealAt, reportingOffsetMinutes: TEHRAN })).toBe('sealed');
    });

    it('the shifted seal instant is 3:30 EARLIER in UTC than the UTC-day one (uniform shift)', () => {
      // A positive reporting_offset moves local midnight earlier in UTC terms,
      // so the whole seal clock shifts back by the same 3:30.
      const utcSeal = ms('2026-07-19T00:00:00Z') + DEFAULT_GRACE_WINDOW_MS;
      expect(sealAt - utcSeal).toBe(-TEHRAN * 60_000);
    });
  });

  it('honours a custom grace window', () => {
    // 0-grace: seals exactly at D_end.
    const dEnd = ms('2026-07-19T00:00:00Z');
    expect(checkSealState({ correctedTime: eventTime, now: dEnd, reportingOffsetMinutes: 0, graceWindowMs: 0 })).toBe(
      'sealed',
    );
  });

  it('isMutable is true for open/grace, false for sealed', () => {
    expect(isMutable('open')).toBe(true);
    expect(isMutable('grace')).toBe(true);
    expect(isMutable('sealed')).toBe(false);
  });
});
