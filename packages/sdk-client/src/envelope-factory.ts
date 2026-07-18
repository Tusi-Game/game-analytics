/**
 * Envelope factory (spec §3.1, §2.3, Foundation §1.1).
 *
 * The SINGLE place client envelopes are assembled. It:
 *   - mints `event_id` per event at capture (collision-safe, {@link mintId});
 *   - stamps `client_event_time` = capture wall clock;
 *   - attaches the current `user_id` (iff identified), `anon_id` (always),
 *     `session_id` (the current session);
 *   - NEVER emits `game_id` (server-derived) or `server_received_time`
 *     (collector-stamped) — structurally excluded (P12);
 *   - NEVER emits `client_sent_time` — the transport stamps it at FLUSH (§2.3);
 *   - forbids any top-level field outside {@link ALLOWED_ENVELOPE_KEYS}: all
 *     free-form context rides inside `props`.
 *
 * The returned object is a partial envelope (no `client_sent_time`,
 * no `game_id`, no `server_received_time`) — the queue stores exactly this, and
 * the transport adds `client_sent_time` per attempt.
 */

import type { EventEnvelope, EventKind } from './wire';
import { mintId } from './ids';

/** A captured envelope minus the flush-stamped / server-derived fields. */
export type CapturedEnvelope = Omit<EventEnvelope, 'game_id' | 'server_received_time' | 'client_sent_time'>;

export interface CaptureIdentity {
  anonId: string;
  userId: string | undefined;
  sessionId: string | undefined;
}

export interface CaptureInput {
  name: string;
  kind: EventKind;
  props: Record<string, unknown>;
  /** Capture wall-clock ms. */
  clientEventTime: number;
  /** Override the current session id (terminal/reconciled session events). */
  sessionIdOverride?: string;
}

/**
 * Build one captured envelope. `sessionIdOverride` lets the session tracker
 * stamp the id of the session being CLOSED on a terminal event (which may differ
 * from the "current" session when reconciling).
 */
export function buildEnvelope(input: CaptureInput, identity: CaptureIdentity): CapturedEnvelope {
  const env: CapturedEnvelope = {
    event_id: mintId(),
    anon_id: identity.anonId,
    name: input.name,
    kind: input.kind,
    client_event_time: input.clientEventTime,
    props: input.props,
  };
  if (identity.userId !== undefined) env.user_id = identity.userId;
  const sessionId = input.sessionIdOverride ?? identity.sessionId;
  if (sessionId !== undefined) env.session_id = sessionId;
  return env;
}
