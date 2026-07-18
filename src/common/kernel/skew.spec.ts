import { correctSkew, MonotonicityMonitor, SKEW_DEAD_BAND_MS } from './skew';

/**
 * Skew correction (foundation §4.2): dead-band, future-clamp, 26h sanity clamp
 * → time_fallback, plus the monotonicity alarm.
 */
describe('correctSkew (foundation §4.2)', () => {
  const base = Date.parse('2026-07-18T12:00:00Z');

  it('applies the skew when |skew| > 60s dead-band', () => {
    // client clock 10 min behind: sent at 11:50, server got it at 12:00.
    const r = correctSkew({
      clientEventTime: base - 10 * 60_000, // 11:50
      clientSentTime: base - 10 * 60_000, // 11:50
      serverReceivedTime: base, // 12:00
    });
    // skew = +10min > 60s → corrected = 11:50 + 10min = 12:00.
    expect(r.correctedTime).toBe(base);
    expect(r.timeFallback).toBe(false);
  });

  it('does NOT correct within the 60s dead-band', () => {
    const skew = 30_000; // 30s < 60s
    const r = correctSkew({
      clientEventTime: base,
      clientSentTime: base,
      serverReceivedTime: base + skew,
    });
    expect(r.correctedTime).toBe(base); // unchanged
    expect(r.timeFallback).toBe(false);
  });

  it('exactly 60s skew is still within the dead-band (strict > )', () => {
    const r = correctSkew({
      clientEventTime: base,
      clientSentTime: base,
      serverReceivedTime: base + SKEW_DEAD_BAND_MS,
    });
    expect(r.correctedTime).toBe(base);
  });

  it('future-clamps a corrected time past server_received_time', () => {
    // client clock 5 min AHEAD → corrected would be in the future.
    const r = correctSkew({
      clientEventTime: base + 5 * 60_000,
      clientSentTime: base + 5 * 60_000,
      serverReceivedTime: base,
    });
    expect(r.correctedTime).toBe(base); // clamped to arrival
    expect(r.timeFallback).toBe(false);
  });

  it('sanity-clamps a corrected time > 26h from arrival → time_fallback on arrival', () => {
    // A very old event_time with a fresh send (skew ≈ 0, so no correction) →
    // corrected stays 30h before arrival, tripping the sanity clamp.
    const off = 30 * 60 * 60_000;
    const r = correctSkew({
      clientEventTime: base - off,
      clientSentTime: base, // fresh send → dead-band, no correction applied
      serverReceivedTime: base,
    });
    expect(r.timeFallback).toBe(true);
    expect(r.correctedTime).toBe(base); // buckets on server_received_time
  });

  it('a corrected time just under 26h is trusted (no fallback)', () => {
    const off = 25 * 60 * 60_000;
    const r = correctSkew({
      clientEventTime: base - off,
      clientSentTime: base, // fresh send → no correction
      serverReceivedTime: base,
    });
    expect(r.timeFallback).toBe(false);
    expect(r.correctedTime).toBe(base - off);
  });

  it('respects a custom clockSanityMaxHours', () => {
    // A near-zero skew (client sent ~now) but a very old event_time → corrected
    // stays ~5h back from arrival, exceeding the tightened 4h horizon.
    const off = 5 * 60 * 60_000; // event occurred 5h ago
    const r = correctSkew({
      clientEventTime: base - off, // 5h back
      clientSentTime: base, // sent ~now (skew ≈ 0)
      serverReceivedTime: base,
      clockSanityMaxHours: 4, // tighter than the 5h gap
    });
    expect(r.timeFallback).toBe(true);
    expect(r.correctedTime).toBe(base);
  });
});

describe('MonotonicityMonitor (foundation §4.2 guard 2)', () => {
  it('does not alarm on the first observation', () => {
    const m = new MonotonicityMonitor();
    expect(m.observe(1000)).toBe(false);
  });

  it('does not alarm on forward progress', () => {
    const m = new MonotonicityMonitor();
    m.observe(1000);
    expect(m.observe(2000)).toBe(false);
  });

  it('alarms when the clock steps backward', () => {
    const m = new MonotonicityMonitor();
    m.observe(2000);
    expect(m.observe(1000)).toBe(true); // stepped back → alert
  });

  it('re-arms after a dip (high-water mark), alarming again on a new regression', () => {
    const m = new MonotonicityMonitor();
    m.observe(2000);
    expect(m.observe(1000)).toBe(true); // first regression
    expect(m.observe(3000)).toBe(false); // recovers past HWM
    expect(m.observe(2500)).toBe(true); // new regression below HWM
  });
});
