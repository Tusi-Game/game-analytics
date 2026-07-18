/**
 * Step-3 strict `session` payload validator ([003-sessions] design step 3(1) + API
 * table, T-02.7..9). Registered with the kind dispatcher for `kind = session`.
 *
 * SHAPE-ONLY (Foundation §4.4): a missing/malformed REQUIRED prop → quarantine
 * (`quarantined_typed`, raw-appended-with-marker, feeds nothing). SEMANTIC
 * anomalies (negative span, cap breach, zero duration) are NOT the validator's
 * concern — they clamp-and-accept in the trusted-time derivation (design §5, API
 * "value disagreement is never a violation").
 *
 * Required props:
 *   - `session_id`         opaque string (never parsed for structure);
 *   - `session_start_time` parseable timestamp (epoch ms number OR ISO string);
 *   - `session_end_time`   parseable timestamp;
 *   - `duration_ms`        integer ≥ 0 (untrusted — server recomputes; still must
 *                          be present + well-shaped, per the API table).
 * Optional:
 *   - `reason ∈ {timeout, app_close, reconciled}` — an UNKNOWN value is treated as
 *     absent (never a quarantine cause; informational only).
 */

import { Injectable } from '@nestjs/common';
import type { EventEnvelope, EventKind } from '../common/contracts/envelope';
import type { TypedValidator } from '../workers/kernel/ingest-kernel';

/** Recognized session end-reason values (an unknown value is treated as absent). */
export const SESSION_REASONS = ['timeout', 'app_close', 'reconciled'] as const;
export type SessionReason = (typeof SESSION_REASONS)[number];

/**
 * Parse a session-payload timestamp: an epoch-ms number, or an ISO-8601 string.
 * Returns the epoch ms, or null if unparseable. Used by both the validator (shape
 * check) and the durable/hot path (via {@link readSessionTimestamp}).
 */
export function parseSessionTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) {
      return ms;
    }
  }
  return null;
}

/** Same as {@link parseSessionTimestamp}; named for use at the read sites. */
export const readSessionTimestamp = parseSessionTimestamp;

@Injectable()
export class SessionValidator implements TypedValidator {
  validate(kind: EventKind, envelope: EventEnvelope): 'quarantined_typed' | null {
    // The dispatcher only routes `session` here, but guard defensively so a stray
    // call for another kind is a permissive no-op (never a false quarantine).
    if (kind !== 'session') {
      return null;
    }
    const props = envelope.props;

    // session_id — opaque non-empty string.
    const sessionId = props['session_id'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return 'quarantined_typed';
    }

    // session_start_time / session_end_time — parseable timestamps.
    if (parseSessionTimestamp(props['session_start_time']) === null) {
      return 'quarantined_typed';
    }
    if (parseSessionTimestamp(props['session_end_time']) === null) {
      return 'quarantined_typed';
    }

    // duration_ms — integer ≥ 0 (present + well-shaped; value untrusted).
    const durationMs = props['duration_ms'];
    if (typeof durationMs !== 'number' || !Number.isInteger(durationMs) || durationMs < 0) {
      return 'quarantined_typed';
    }

    // reason is OPTIONAL — unknown value treated as absent, never a quarantine.
    return null;
  }
}

/** Read the `reason` prop, mapping anything not in the enum to `undefined`. */
export function readSessionReason(props: Record<string, unknown>): SessionReason | undefined {
  const raw = props['reason'];
  return typeof raw === 'string' && (SESSION_REASONS as readonly string[]).includes(raw)
    ? (raw as SessionReason)
    : undefined;
}
