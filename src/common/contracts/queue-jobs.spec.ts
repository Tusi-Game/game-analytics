import type { EventEnvelope } from './envelope';
import type { Disposition, FrontDoorVerdicts, IngestJob, RoutedRecord, SealState } from './queue-jobs';
import { EXCEPTION_REASONS, type ExceptionReason } from './exception-reason';

/**
 * Contract freeze test for the RoutedRecord (R1 — Stage A gate).
 *
 * The routed record is the single frozen handoff from the ingest producer (01)
 * to the three typed consumers (02/03/05). If a field is dropped or its type
 * drifts, this file fails to COMPILE — which fails the build and the gate.
 * Consumers read these fields verbatim and never re-derive a front-door
 * decision, so the shape is load-bearing.
 */
describe('RoutedRecord contract (R1, foundation §3.1)', () => {
  const envelope: EventEnvelope = {
    game_id: 'game-42',
    user_id: 'u1',
    event_id: 'evt-1',
    name: 'purchase',
    kind: 'generic', // DECLARED kind…
    client_event_time: 1_700_000_000_000,
    client_sent_time: 1_700_000_000_050,
    server_received_time: 1_700_000_000_100,
    props: {},
  };

  it('carries the full frozen field set with the resolved kind distinct from the wire kind', () => {
    const record: RoutedRecord = {
      envelope,
      // §H-2 override: reserved name "purchase" resolves to typed path even
      // though the wire kind was "generic". resolved_kind is authoritative.
      resolved_kind: 'purchase',
      v: 1,
      corrected_time: 1_700_000_000_120,
      corrected_day: '2026-07-18',
      provenance: 'client',
      verdicts: {
        dedup_passed: true,
        seal_state: 'open',
        disposition: 'route',
      },
    };

    expect(record.resolved_kind).toBe('purchase');
    expect(record.envelope.kind).toBe('generic');
    expect(record.resolved_kind).not.toBe(record.envelope.kind);
    expect(record.v).toBe(1);
    expect(record.corrected_day).toBe('2026-07-18');
    expect(record.verdicts.disposition).toBe('route');
  });

  it('encodes every seal state', () => {
    const states: SealState[] = ['open', 'grace', 'sealed'];
    expect(states).toHaveLength(3);
  });

  it('encodes every disposition', () => {
    const dispositions: Disposition[] = ['route', 'drop', 'quarantine'];
    expect(dispositions).toHaveLength(3);
  });

  it('carries a reason drawn from the canonical ExceptionReason union on non-route', () => {
    const reason: ExceptionReason = 'quarantined_typed';
    const verdicts: FrontDoorVerdicts = {
      dedup_passed: false,
      seal_state: 'sealed',
      disposition: 'quarantine',
      reason,
    };
    expect(EXCEPTION_REASONS).toContain(verdicts.reason);
  });

  it('omits reason on a clean route (optional field)', () => {
    const verdicts: FrontDoorVerdicts = {
      dedup_passed: true,
      seal_state: 'open',
      disposition: 'route',
    };
    expect(verdicts.reason).toBeUndefined();
  });

  it('wraps routed records in an IngestJob', () => {
    const job: IngestJob = {
      batch_id: 'batch-1',
      routed_records: [],
    };
    expect(job.routed_records).toEqual([]);
  });
});
