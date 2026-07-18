import {
  utcDay,
  logicalDay,
  logicalDayStartUtcMs,
  logicalDayEndUtcMs,
  eventBucketDay,
  fallbackBucketDay,
  arrivalBucketDay,
} from './logical-day';

/**
 * DARK-SPOT #4 — logical-day is dormant at offset=0 and silently wrong once the
 * operator sets a non-UTC offset. These tests pin the +03:30 (210 min) case:
 * events bucket correctly, the seal clock is shifted the SAME, the offset is
 * applied ONCE, and the three bucket rules pick the right timestamp.
 */
describe('logical-day (foundation §4.7, P8)', () => {
  const TEHRAN = 210; // +03:30 in minutes

  const ms = (iso: string): number => Date.parse(iso);

  describe('utcDay / logicalDay primitives', () => {
    it('utcDay formats the UTC calendar day', () => {
      expect(utcDay(ms('2026-07-18T00:00:00Z'))).toBe('2026-07-18');
      expect(utcDay(ms('2026-07-18T23:59:59Z'))).toBe('2026-07-18');
      expect(utcDay(ms('2026-07-19T00:00:00Z'))).toBe('2026-07-19');
    });

    it('at offset 0, logicalDay === utcDay (dormant case)', () => {
      const t = ms('2026-07-18T01:00:00Z');
      expect(logicalDay(t, 0)).toBe(utcDay(t));
      expect(logicalDay(t, 0)).toBe('2026-07-18');
    });

    it('at +3:30, an event at 01:00Z lands in the LOCAL day (offset applied once)', () => {
      // 01:00Z + 3:30 = 04:30 local → still 2026-07-18 local-day.
      expect(logicalDay(ms('2026-07-18T01:00:00Z'), TEHRAN)).toBe('2026-07-18');
    });

    it('at +3:30, an event at 21:00Z rolls into the NEXT local day', () => {
      // 21:00Z + 3:30 = 00:30 next-day local → 2026-07-19.
      expect(logicalDay(ms('2026-07-18T21:00:00Z'), TEHRAN)).toBe('2026-07-19');
    });

    it('at +3:30, an event at 20:00Z (23:30 local) stays in the same local day', () => {
      expect(logicalDay(ms('2026-07-18T20:00:00Z'), TEHRAN)).toBe('2026-07-18');
    });

    it('the offset is applied exactly ONCE — re-feeding logicalDay output does not double-shift', () => {
      // Bucketing through logicalDay once is correct; there is no second apply.
      // Prove the boundary is at 20:30Z (= 00:00 local next day), not 17:00Z
      // (which a double +3:30 would produce).
      expect(logicalDay(ms('2026-07-18T20:29:00Z'), TEHRAN)).toBe('2026-07-18');
      expect(logicalDay(ms('2026-07-18T20:30:00Z'), TEHRAN)).toBe('2026-07-19');
    });
  });

  describe('seal-clock boundaries shift with the SAME offset', () => {
    it('logicalDayStartUtcMs returns the local-midnight instant as a true UTC epoch', () => {
      // Local midnight of 2026-07-18 in +3:30 = 2026-07-17T20:30:00Z.
      const start = logicalDayStartUtcMs(ms('2026-07-18T10:00:00Z'), TEHRAN);
      expect(new Date(start).toISOString()).toBe('2026-07-17T20:30:00.000Z');
    });

    it('logicalDayEndUtcMs is exactly 24h after the start (D_end)', () => {
      const start = logicalDayStartUtcMs(ms('2026-07-18T10:00:00Z'), TEHRAN);
      const end = logicalDayEndUtcMs(ms('2026-07-18T10:00:00Z'), TEHRAN);
      expect(end - start).toBe(24 * 60 * 60_000);
      // D_end = 2026-07-18T20:30:00Z (local midnight of the 19th).
      expect(new Date(end).toISOString()).toBe('2026-07-18T20:30:00.000Z');
    });

    it('at offset 0 the day floor is plain UTC midnight', () => {
      const start = logicalDayStartUtcMs(ms('2026-07-18T10:00:00Z'), 0);
      expect(new Date(start).toISOString()).toBe('2026-07-18T00:00:00.000Z');
    });
  });

  describe('the three DISTINCT bucket rules (never mixed)', () => {
    const corrected = ms('2026-07-18T21:00:00Z'); // → local 2026-07-19 at +3:30
    const serverReceived = ms('2026-07-18T10:00:00Z'); // → local 2026-07-18 at +3:30

    it('normal event buckets on CORRECTED time', () => {
      expect(eventBucketDay(corrected, TEHRAN)).toBe('2026-07-19');
    });

    it('time_fallback event buckets on SERVER-RECEIVED time, not corrected', () => {
      expect(fallbackBucketDay(serverReceived, TEHRAN)).toBe('2026-07-18');
      // and it differs from what the (untrusted) corrected time would give:
      expect(fallbackBucketDay(serverReceived, TEHRAN)).not.toBe(eventBucketDay(corrected, TEHRAN));
    });

    it('EXCEPTION_TALLY buckets on the ARRIVAL (server-received) day', () => {
      expect(arrivalBucketDay(serverReceived, TEHRAN)).toBe('2026-07-18');
    });
  });

  describe('input guards', () => {
    it('rejects a non-integer reporting offset', () => {
      expect(() => logicalDay(Date.now(), 3.5)).toThrow(/integer minute/);
    });
    it('rejects a non-finite epoch', () => {
      expect(() => utcDay(Number.NaN)).toThrow(/finite/);
    });
  });
});
