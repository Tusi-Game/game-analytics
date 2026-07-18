/**
 * Session trusted-time derivation ([003-sessions] design step 3, T-02.10..12/21)
 * — PURE functions (no clock reads, no I/O).
 *
 * The server is authoritative for duration. It NEVER trusts the client's
 * `duration_ms`; it RECOMPUTES `trusted_duration = corrected_end − corrected_start`
 * (clamp 0 if negative → cap `session_max_duration_cap_min` → floor
 * `session_min_duration_ms`), builds the trusted interval, and splits duration
 * per UTC/logical day. Client `duration_ms` is a sanity signal only — never folded
 * and never a rejection cause (all clamps ACCEPT; §5).
 *
 * Skew: the two payload timestamps are corrected with the SAME step-2 envelope
 * skew (`server_received_time − client_sent_time`, 60 s dead-band) and each is
 * future-clamped to server-now (== `server_received_time`) — mirroring
 * {@link correctSkew} but applied to the session's own start/end instants
 * (Foundation §4.2).
 */

import { SKEW_DEAD_BAND_MS } from '../common/kernel/skew';
import { logicalDay, logicalDayStartUtcMs, logicalDayEndUtcMs } from '../common/kernel/logical-day';

/** The three §6 session knobs the trusted-duration derivation consumes. */
export interface SessionTimeKnobs {
  /** `session_max_duration_cap_min` — default 720 (12 h). */
  maxDurationCapMin: number;
  /** `session_min_duration_ms` — default 0 (single-event floor). */
  minDurationMs: number;
}

/** The §6 session-knob DEFAULTS ([003-sessions] §6). */
export const SESSION_TIME_DEFAULTS: SessionTimeKnobs = {
  maxDurationCapMin: 720,
  minDurationMs: 0,
};

/** The trusted, server-recomputed session interval + its bucketing days. */
export interface TrustedSession {
  /** Skew-corrected, future-clamped start (epoch ms). */
  correctedStart: number;
  /** Skew-corrected, future-clamped end BEFORE recompute (epoch ms) — diagnostic only. */
  correctedEnd: number;
  /** Server-recomputed duration (ms) after clamp-0 → cap → floor. */
  trustedDuration: number;
  /** End of the trusted interval = correctedStart + trustedDuration (epoch ms). */
  trustedEnd: number;
  /** Logical START day (governs count, bit, act membership, seal gate). */
  startDay: string;
  /**
   * Logical END day of the trusted interval, iff it differs from `startDay`
   * (positive overlap with a second, adjacent day); else `null`.
   */
  endDay: string | null;
}

/** Apply the step-2 envelope skew (with dead-band) + future-clamp to one instant. */
function correctInstant(instantMs: number, clientSentTime: number, serverReceivedTime: number): number {
  const skew = serverReceivedTime - clientSentTime;
  const corrected = Math.abs(skew) > SKEW_DEAD_BAND_MS ? instantMs + skew : instantMs;
  // Future-clamp: a session instant can never be dated after the server saw it.
  return Math.min(corrected, serverReceivedTime);
}

/**
 * Derive the trusted session interval from the raw payload times + the envelope
 * skew reference + the §6 knobs + the platform reporting offset.
 *
 * @param rawStartMs raw client `session_start_time` (epoch ms).
 * @param rawEndMs   raw client `session_end_time` (epoch ms).
 * @param clientSentTime envelope `client_sent_time` (epoch ms) — skew reference.
 * @param serverReceivedTime envelope `server_received_time` (epoch ms) — skew ref + future-clamp.
 * @param knobs `session_max_duration_cap_min` + `session_min_duration_ms`.
 * @param reportingOffsetMinutes platform `reporting_offset` (Foundation §4.7).
 */
export function deriveTrustedSession(
  rawStartMs: number,
  rawEndMs: number,
  clientSentTime: number,
  serverReceivedTime: number,
  knobs: SessionTimeKnobs,
  reportingOffsetMinutes: number,
): TrustedSession {
  const correctedStart = correctInstant(rawStartMs, clientSentTime, serverReceivedTime);
  const correctedEnd = correctInstant(rawEndMs, clientSentTime, serverReceivedTime);

  // Server RECOMPUTES the trusted duration — client duration_ms is never used.
  const rawDuration = correctedEnd - correctedStart;
  const capMs = knobs.maxDurationCapMin * 60_000;
  // clamp 0 if negative → cap → floor (order per design step 3(3)).
  let trustedDuration = Math.max(0, rawDuration);
  trustedDuration = Math.min(trustedDuration, capMs);
  trustedDuration = Math.max(trustedDuration, knobs.minDurationMs);

  const trustedEnd = correctedStart + trustedDuration;

  const startDay = logicalDay(correctedStart, reportingOffsetMinutes);
  // The trusted interval end instant is [correctedStart, trustedEnd); the last
  // instant that carries duration is trustedEnd. A zero-length session that ends
  // exactly at a day boundary contributes only to the start day.
  const endInstant = trustedEnd > correctedStart ? trustedEnd : correctedStart;
  const endDayRaw = logicalDay(endInstant, reportingOffsetMinutes);
  // The trusted interval is a half-open [start, end); if `end` lands exactly on a
  // day boundary (start-of-next-day) the second day has ZERO overlap, so it is
  // not a touched day. dur_on_day already returns 0 there, but we also avoid
  // reporting a phantom endDay.
  const endDay =
    endDayRaw !== startDay && durOnDay({ correctedStart, trustedEnd }, endDayRaw, reportingOffsetMinutes) > 0
      ? endDayRaw
      : null;

  return { correctedStart, correctedEnd, trustedDuration, trustedEnd, startDay, endDay };
}

/** The minimal trusted-interval shape {@link durOnDay} needs. */
export interface Interval {
  correctedStart: number;
  trustedEnd: number;
}

/**
 * `dur_on_day(s, D) = max(0, min(end_s, D_end) − max(start_s, D_start))` over the
 * TRUSTED interval ([003-sessions] §2). `D` is a logical day "YYYY-MM-DD";
 * D_start/D_end are its logical-day boundaries in UTC epoch ms (Foundation §4.7).
 */
export function durOnDay(interval: Interval, day: string, reportingOffsetMinutes: number): number {
  // Anchor the day boundaries off an instant inside the day (its logical noon is
  // irrelevant; use the day-start of the corrected start when the day matches,
  // otherwise reconstruct from a midpoint of `day`). Simplest robust anchor:
  // parse the day as UTC midnight then shift into the logical frame.
  const dayUtcMidnight = Date.parse(`${day}T00:00:00Z`);
  // `logicalDayStartUtcMs` maps any instant to the START of its logical day. An
  // instant one logical-hour into `day` guarantees we land in `day`'s logical
  // window regardless of the offset sign, so the reconstructed boundaries are the
  // true logical-day bounds.
  const probe = dayUtcMidnight + reportingOffsetMinutes * 60_000 + 60_000;
  const dStart = logicalDayStartUtcMs(probe, reportingOffsetMinutes);
  const dEnd = logicalDayEndUtcMs(probe, reportingOffsetMinutes);
  return Math.max(0, Math.min(interval.trustedEnd, dEnd) - Math.max(interval.correctedStart, dStart));
}
