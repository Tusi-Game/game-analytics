import type { EventEnvelope, EventKind } from './envelope';

/**
 * Type-level test for the canonical envelope (Foundation §1.1). If a required
 * key is dropped or a field type changes, this file fails to compile — which
 * fails the build/test. A tiny runtime assertion keeps Jest from reporting an
 * empty test file.
 */
describe('EventEnvelope contract', () => {
  it('accepts a fully-populated envelope and enforces required keys', () => {
    const envelope: EventEnvelope = {
      game_id: 'game-1',
      user_id: 'user-1',
      anon_id: 'anon-1',
      session_id: 'session-1',
      event_id: 'evt-1',
      name: 'level_complete',
      kind: 'generic',
      client_event_time: 1_700_000_000_000,
      client_sent_time: 1_700_000_000_100,
      server_received_time: 1_700_000_000_200,
      props: { level: 4, score: 900 },
    };

    // Optional identity fields may be omitted.
    const minimal: EventEnvelope = {
      game_id: 'game-1',
      event_id: 'evt-2',
      name: 'ping',
      kind: 'generic',
      client_event_time: 1,
      client_sent_time: 2,
      server_received_time: 3,
      props: {},
    };

    // Open enum: known literals and arbitrary strings both assignable.
    const known: EventKind = 'purchase';
    const custom: EventKind = 'level_up';

    expect(envelope.game_id).toBe('game-1');
    expect(minimal.user_id).toBeUndefined();
    expect(known).toBe('purchase');
    expect(custom).toBe('level_up');
  });
});
