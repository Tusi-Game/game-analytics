/**
 * Unit tests for the strict step-3 `session` validator — shape-only quarantine,
 * semantic anomalies accepted (clamp-and-accept downstream).
 */

import { SessionValidator, readSessionReason, parseSessionTimestamp } from './session-validator';
import type { EventEnvelope } from '../common/contracts/envelope';

function env(props: Record<string, unknown>): EventEnvelope {
  const t = Date.parse('2026-07-16T09:00:00Z');
  return {
    game_id: 'g',
    event_id: 'e1',
    name: 'session',
    kind: 'session',
    user_id: 'u1',
    client_event_time: t,
    client_sent_time: t,
    server_received_time: t,
    props,
  };
}

describe('SessionValidator (step 3, shape-only)', () => {
  const v = new SessionValidator();
  const valid = {
    session_id: 's1',
    session_start_time: Date.parse('2026-07-16T09:00:00Z'),
    session_end_time: Date.parse('2026-07-16T09:10:00Z'),
    duration_ms: 600_000,
  };

  it('accepts a well-shaped session payload', () => {
    expect(v.validate('session', env(valid))).toBeNull();
  });

  it('accepts ISO-string timestamps', () => {
    expect(v.validate('session', env({ ...valid, session_start_time: '2026-07-16T09:00:00Z' }))).toBeNull();
  });

  it('quarantines a missing session_id', () => {
    const { session_id: _omit, ...rest } = valid;
    void _omit;
    expect(v.validate('session', env(rest))).toBe('quarantined_typed');
  });

  it('quarantines an unparseable session_start_time', () => {
    expect(v.validate('session', env({ ...valid, session_start_time: 'not-a-time' }))).toBe('quarantined_typed');
  });

  it('quarantines a missing session_end_time', () => {
    const { session_end_time: _omit, ...rest } = valid;
    void _omit;
    expect(v.validate('session', env(rest))).toBe('quarantined_typed');
  });

  it('quarantines a negative / non-integer duration_ms (shape violation)', () => {
    expect(v.validate('session', env({ ...valid, duration_ms: -1 }))).toBe('quarantined_typed');
    expect(v.validate('session', env({ ...valid, duration_ms: 1.5 }))).toBe('quarantined_typed');
    expect(v.validate('session', env({ ...valid, duration_ms: 'x' }))).toBe('quarantined_typed');
  });

  it('is a permissive no-op for a non-session kind', () => {
    expect(v.validate('economy', env(valid))).toBeNull();
  });
});

describe('readSessionReason — unknown value treated as absent', () => {
  it('returns a recognised reason', () => {
    expect(readSessionReason({ reason: 'timeout' })).toBe('timeout');
    expect(readSessionReason({ reason: 'reconciled' })).toBe('reconciled');
  });
  it('maps an unknown / absent reason to undefined (never a quarantine)', () => {
    expect(readSessionReason({ reason: 'bogus' })).toBeUndefined();
    expect(readSessionReason({})).toBeUndefined();
  });
});

describe('parseSessionTimestamp', () => {
  it('accepts epoch-ms numbers and ISO strings, rejects garbage', () => {
    expect(parseSessionTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(parseSessionTimestamp('2026-07-16T09:00:00Z')).toBe(Date.parse('2026-07-16T09:00:00Z'));
    expect(parseSessionTimestamp('nope')).toBeNull();
    expect(parseSessionTimestamp(null)).toBeNull();
    expect(parseSessionTimestamp(undefined)).toBeNull();
  });
});
