/**
 * Unit tests for the PURE session trusted-time derivation — the server-authoritative
 * duration recompute, the midnight duration split, and dur_on_day. No infra.
 *
 * Realistic wire model: the SDK sends the terminal `session` event right after the
 * session ends, so `client_sent_time ≈ session_end_time` and `server_received_time
 * ≈ client_sent_time` (small skew). The envelope skew (server_received − client_sent)
 * is applied to BOTH start and end, preserving the duration; the future-clamp only
 * fires for a genuinely future-dated instant.
 */

import { deriveTrustedSession, durOnDay, SESSION_TIME_DEFAULTS } from './session-time';

const MIN = 60_000;

/**
 * Build a realistic (clientSentTime, serverReceivedTime) pair for a session that
 * ended at `end`: the batch flushes ~1 s after end, the server receives it ~1 s
 * later (well under the 60 s dead-band → skew is a no-op, duration preserved).
 */
function wire(end: number): { sent: number; recv: number } {
  const sent = end + 1000;
  return { sent, recv: sent + 1000 };
}

describe('deriveTrustedSession — server-authoritative recompute', () => {
  it('recomputes trusted_duration = corrected_end − corrected_start (never trusts client)', () => {
    const start = Date.parse('2026-07-16T09:00:00Z');
    const end = Date.parse('2026-07-16T09:10:00Z'); // 10 min
    const w = wire(end);
    // Client LIES that duration is 1 ms — server ignores it and recomputes 10 min.
    const s = deriveTrustedSession(start, end, w.sent, w.recv, SESSION_TIME_DEFAULTS, 0);
    expect(s.trustedDuration).toBe(10 * MIN);
    expect(s.startDay).toBe('2026-07-16');
    expect(s.endDay).toBeNull();
  });

  it('clamps a negative span (client clock ran backward) to 0 — session still valid', () => {
    const start = Date.parse('2026-07-16T09:00:00Z');
    const end = start - 5 * MIN; // end BEFORE start
    const w = wire(start);
    const s = deriveTrustedSession(start, end, w.sent, w.recv, SESSION_TIME_DEFAULTS, 0);
    expect(s.trustedDuration).toBe(0);
  });

  it('caps an absurd duration at session_max_duration_cap_min (never inflates)', () => {
    const start = Date.parse('2026-07-16T00:00:00Z');
    const end = start + 48 * 60 * MIN; // 48 h — beyond the 12 h cap
    const w = wire(end);
    const s = deriveTrustedSession(start, end, w.sent, w.recv, { maxDurationCapMin: 720, minDurationMs: 0 }, 0);
    expect(s.trustedDuration).toBe(720 * MIN); // capped at 12 h
  });

  it('floors a single-event (zero) session by session_min_duration_ms', () => {
    const start = Date.parse('2026-07-16T09:00:00Z');
    const w = wire(start);
    const s = deriveTrustedSession(start, start, w.sent, w.recv, { maxDurationCapMin: 720, minDurationMs: 1000 }, 0);
    expect(s.trustedDuration).toBe(1000);
  });

  it('reports a second (end) day for a midnight-spanning session (spec §2 S1)', () => {
    const start = Date.parse('2026-07-15T23:40:00Z');
    const end = Date.parse('2026-07-16T00:35:00Z'); // 55 min, crosses midnight
    const w = wire(end);
    const s = deriveTrustedSession(start, end, w.sent, w.recv, SESSION_TIME_DEFAULTS, 0);
    expect(s.trustedDuration).toBe(55 * MIN);
    expect(s.startDay).toBe('2026-07-15'); // counted in the START day
    expect(s.endDay).toBe('2026-07-16');
  });

  it('applies a small (>60 s) skew equally to start and end (duration preserved)', () => {
    const start = Date.parse('2026-07-16T09:00:00Z');
    const end = start + 10 * MIN;
    // Client clock is 5 min SLOW: server_received − client_sent = +5 min skew.
    const clientSent = end;
    const serverRecv = end + 5 * MIN;
    const s = deriveTrustedSession(start, end, clientSent, serverRecv, SESSION_TIME_DEFAULTS, 0);
    expect(s.trustedDuration).toBe(10 * MIN); // duration invariant under a constant skew
    expect(s.correctedStart).toBe(start + 5 * MIN); // both instants shifted by the skew
  });

  it('future-clamps a session end dated after the server saw it', () => {
    const start = Date.parse('2026-07-16T09:00:00Z');
    // Dead-band skew (30 s < 60 s) → no shift; client claims the session ended at
    // 09:15 but the server received it at 09:10 → the end clamps to server-now,
    // shrinking the trusted duration to 10 min (never inflated to the future).
    const clientSent = Date.parse('2026-07-16T09:09:30Z');
    const serverRecv = Date.parse('2026-07-16T09:10:00Z');
    const end = Date.parse('2026-07-16T09:15:00Z');
    const s = deriveTrustedSession(start, end, clientSent, serverRecv, SESSION_TIME_DEFAULTS, 0);
    expect(s.trustedEnd).toBeLessThanOrEqual(serverRecv);
    expect(s.trustedDuration).toBe(10 * MIN);
  });
});

describe('durOnDay — the midnight duration split (spec §2 worked example)', () => {
  it('splits S1 (23:40 07-15 → 00:35 07-16) as 20 min on 07-15 and 35 min on 07-16', () => {
    const start = Date.parse('2026-07-15T23:40:00Z');
    const interval = { correctedStart: start, trustedEnd: start + 55 * MIN };
    expect(durOnDay(interval, '2026-07-15', 0)).toBe(20 * MIN);
    expect(durOnDay(interval, '2026-07-16', 0)).toBe(35 * MIN);
    expect(durOnDay(interval, '2026-07-15', 0) + durOnDay(interval, '2026-07-16', 0)).toBe(55 * MIN);
  });

  it('returns 0 for a day the interval does not touch', () => {
    const start = Date.parse('2026-07-16T09:00:00Z');
    const interval = { correctedStart: start, trustedEnd: start + 10 * MIN };
    expect(durOnDay(interval, '2026-07-15', 0)).toBe(0);
    expect(durOnDay(interval, '2026-07-17', 0)).toBe(0);
  });

  it('honours the reporting_offset (logical day) — a session near UTC midnight at +210', () => {
    // +03:30 offset. 22:00 UTC on 07-15 is 01:30 local on 07-16 → logical day 07-16.
    const start = Date.parse('2026-07-15T22:00:00Z');
    const w = wire(start + 30 * MIN);
    const s = deriveTrustedSession(start, start + 30 * MIN, w.sent, w.recv, SESSION_TIME_DEFAULTS, 210);
    expect(s.startDay).toBe('2026-07-16');
  });
});
