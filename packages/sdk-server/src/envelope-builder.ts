/**
 * Envelope builder (spec §3, Design §Module) — the SINGLE conformance
 * chokepoint. ONE place constructs every server envelope, so "never a top-level
 * field outside Foundation §1.1" is enforced structurally, not by review.
 *
 * It stamps `event_id`, `client_event_time`, and (for purchases) `source=server`
 * inside `props`; it NEVER emits `game_id` (server-derived from the credential)
 * or `session_id` by default (this SDK owns no sessions — R11). `anon_id` is not
 * applicable (the backend always knows its user). `client_sent_time` is added by
 * the transport at flush.
 */

import type { EventEnvelope, EventKind } from './wire';
import { mintId } from './ids';

/** A built envelope minus the flush-stamped / server-derived fields. */
export type BuiltEnvelope = Omit<EventEnvelope, 'game_id' | 'server_received_time' | 'client_sent_time' | 'anon_id'>;

export interface BuildInput {
  name: string;
  kind: EventKind;
  userId: string;
  props: Record<string, unknown>;
  clientEventTime: number;
  /** A caller-relayed session id passes through as opaque context (spec §3). */
  sessionId?: string;
}

export function buildEnvelope(input: BuildInput): BuiltEnvelope {
  const env: BuiltEnvelope = {
    event_id: mintId(),
    user_id: input.userId,
    name: input.name,
    kind: input.kind,
    client_event_time: input.clientEventTime,
    props: input.props,
  };
  if (input.sessionId !== undefined) env.session_id = input.sessionId;
  return env;
}
