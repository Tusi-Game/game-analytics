/**
 * Unit tests for the pure `eco`/`bal` field-encoding helpers (T-03.11/44) + the
 * LWW decision + level-bucket compute. No live infra — pure functions only.
 *
 * The load-bearing requirement: `currency`/`reason` LEGITIMATELY contain `:`
 * (`shop_purchase:sword`), so the tuple encoding must round-trip field → cell
 * unambiguously and stably (0x1F separator, never `:`).
 */

import {
  ecoField,
  parseEcoField,
  ecoSegField,
  parseEcoSegField,
  encodeBalanceEntry,
  decodeBalanceEntry,
  incomingWins,
  MEASURE_AMOUNT,
  MEASURE_COUNT,
  balDirtyMember,
  parseBalDirtyMember,
  parseEcoBucketKey,
  type BalanceEntry,
} from './eco-keys';
import { computeLevelBucket } from './economy-config.service';

describe('eco-keys tuple encoding (T-03.11/44) — round-trip stability', () => {
  it('base field round-trips a currency/reason that contain ":"', () => {
    const f = ecoField(MEASURE_AMOUNT, 'server', 'sink', 'gold:premium', 'shop_purchase:sword');
    const parsed = parseEcoField(f);
    expect(parsed).toEqual({
      measure: MEASURE_AMOUNT,
      provenance: 'server',
      flowType: 'sink',
      currency: 'gold:premium',
      reason: 'shop_purchase:sword',
    });
  });

  it('base field distinguishes the amount vs count measure for the SAME cell', () => {
    const a = ecoField(MEASURE_AMOUNT, 'client', 'source', 'gold', 'pvp_win');
    const n = ecoField(MEASURE_COUNT, 'client', 'source', 'gold', 'pvp_win');
    expect(a).not.toBe(n);
    expect(parseEcoField(a)?.measure).toBe(MEASURE_AMOUNT);
    expect(parseEcoField(n)?.measure).toBe(MEASURE_COUNT);
    // Both parse to the SAME cell tuple (only the measure differs).
    expect(parseEcoField(a)?.reason).toBe('pvp_win');
    expect(parseEcoField(n)?.currency).toBe('gold');
  });

  it('segment field round-trips with ":"-bearing reason + segment value', () => {
    const f = ecoSegField(MEASURE_AMOUNT, 'client', 'sink', 'gems', 'region', 'EU:west', 'upgrade:barracks');
    const parsed = parseEcoSegField(f);
    expect(parsed).toEqual({
      measure: MEASURE_AMOUNT,
      provenance: 'client',
      flowType: 'sink',
      currency: 'gems',
      segmentDim: 'region',
      segmentValue: 'EU:west',
      reason: 'upgrade:barracks',
    });
  });

  it('rejects a malformed (too-short) field', () => {
    expect(parseEcoField('a\x1fserver')).toBeNull();
    expect(parseEcoSegField('a\x1fserver\x1fsink')).toBeNull();
  });

  it('bal entry encode/decode round-trips all five fields', () => {
    const e: BalanceEntry = {
      balance: '1300',
      asOfMs: 1_700_000_000_000,
      provenance: 'server',
      serverReceivedMs: 1_700_000_001_000,
      eventId: 'evt-1',
    };
    expect(decodeBalanceEntry(encodeBalanceEntry(e))).toEqual(e);
  });

  it('bal:dirty member round-trips (user_id, currency)', () => {
    const m = balDirtyMember('user-9', 'gold:premium');
    expect(parseBalDirtyMember(m)).toEqual({ userId: 'user-9', currency: 'gold:premium' });
  });

  it('parses eco bucket keys (base vs :seg)', () => {
    expect(parseEcoBucketKey('g1:eco:2026-07-17')).toEqual({ gameId: 'g1', day: '2026-07-17', seg: false });
    expect(parseEcoBucketKey('g1:eco:2026-07-17:seg')).toEqual({ gameId: 'g1', day: '2026-07-17', seg: true });
    expect(parseEcoBucketKey('g1:cnt:2026-07-17')).toBeNull();
  });
});

describe('incomingWins — class-L LWW decision + tie-break (T-03.22/24)', () => {
  const base: BalanceEntry = {
    balance: '100',
    asOfMs: 1000,
    provenance: 'client',
    serverReceivedMs: 5000,
    eventId: 'm',
  };

  it('later as_of wins', () => {
    expect(incomingWins({ ...base, asOfMs: 2000 }, base)).toBe(true);
    expect(incomingWins({ ...base, asOfMs: 500 }, base)).toBe(false); // stale REJECTED
  });

  it('equal as_of → later server_received wins', () => {
    expect(incomingWins({ ...base, serverReceivedMs: 6000 }, base)).toBe(true);
    expect(incomingWins({ ...base, serverReceivedMs: 4000 }, base)).toBe(false);
  });

  it('equal as_of + server_received → greatest event_id wins', () => {
    expect(incomingWins({ ...base, eventId: 'z' }, base)).toBe(true);
    expect(incomingWins({ ...base, eventId: 'a' }, base)).toBe(false);
  });

  it('fully equal → no-op (a retry never re-clobbers)', () => {
    expect(incomingWins(base, { ...base })).toBe(false);
  });
});

describe('computeLevelBucket (T-03.19)', () => {
  const bounds = [10, 20, 30];
  it('buckets below the first boundary', () => {
    expect(computeLevelBucket(5, bounds)).toBe('<10');
  });
  it('buckets inside a band', () => {
    expect(computeLevelBucket(25, bounds)).toBe('20-29');
    expect(computeLevelBucket(10, bounds)).toBe('10-19');
  });
  it('buckets at/above the last boundary', () => {
    expect(computeLevelBucket(30, bounds)).toBe('30+');
    expect(computeLevelBucket(99, bounds)).toBe('30+');
  });
  it('returns null for an absent / non-numeric level (skip the axis)', () => {
    expect(computeLevelBucket(undefined, bounds)).toBeNull();
    expect(computeLevelBucket('x', bounds)).toBeNull();
  });
});
