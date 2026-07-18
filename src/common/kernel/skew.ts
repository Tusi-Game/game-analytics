/**
 * Skew-corrected event time (foundation §4.2, §G) — pure functions.
 *
 *   skew      = server_received_time − client_sent_time
 *   corrected = client_event_time + skew        (only if |skew| > 60 s dead-band)
 *   corrected = min(corrected, server_now)      (future-clamp)
 *   bucket    = logical_day(corrected)                                  (§4.7)
 *
 * Guard 1 — sanity clamp: if `corrected` moves more than
 * `clock_sanity_max_hours` (default 26 h) from `server_received_time`, the event
 * is NOT trusted — it buckets on `server_received_time` and is flagged
 * `time_fallback` (still accepted).
 *
 * Guard 2 — monotonicity alarm: a worker seeing `server_received_time` step
 * BACKWARD between consecutive batches raises an operational alert (the
 * stepped-clock failure). Exposed as {@link MonotonicityMonitor} — a pure,
 * in-memory latch; wiring it to an actual alerting sink is an ops concern.
 *
 * Timestamps are UTC epoch MILLISECONDS throughout. `corrected` is always
 * stored as a UTC epoch; the `reporting_offset` day floor is applied later, in
 * the logical-day helper — NEVER here.
 */

/** Below this absolute skew the correction is a no-op (dead-band). */
export const SKEW_DEAD_BAND_MS = 60_000;

/** Default sanity-clamp horizon: a corrected time this far from arrival is untrusted. */
export const DEFAULT_CLOCK_SANITY_MAX_HOURS = 26;

/** Inputs to the skew correction — the four wire/server timestamps. */
export interface SkewInput {
  /** When the event occurred on the client (epoch ms). */
  clientEventTime: number;
  /** When the client flushed the batch (epoch ms). */
  clientSentTime: number;
  /** When the front door received the batch (epoch ms). */
  serverReceivedTime: number;
  /** Sanity horizon in hours; defaults to {@link DEFAULT_CLOCK_SANITY_MAX_HOURS}. */
  clockSanityMaxHours?: number;
}

/**
 * Result of the skew correction. `timeFallback` is the load-bearing flag: when
 * true the caller MUST bucket on `serverReceivedTime` and tally `time_fallback`
 * (see logical-day `fallbackBucketDay`), NOT on `correctedTime`.
 */
export interface SkewResult {
  /**
   * The skew-corrected event time (epoch ms). When `timeFallback` is true this
   * equals `serverReceivedTime` — the untrusted client-derived value is
   * discarded so a stray corrected time never even leaks into a downstream bug.
   */
  correctedTime: number;
  /**
   * True iff the sanity clamp fired: the client-derived time was unusable and
   * the event must bucket on arrival (`server_received_time`) + `time_fallback`.
   */
  timeFallback: boolean;
}

/**
 * Compute the skew-corrected event time with dead-band, future-clamp and the
 * 26 h sanity clamp. Pure — no clock reads, no I/O.
 */
export function correctSkew(input: SkewInput): SkewResult {
  const { clientEventTime, clientSentTime, serverReceivedTime } = input;
  const sanityMaxMs = (input.clockSanityMaxHours ?? DEFAULT_CLOCK_SANITY_MAX_HOURS) * 60 * 60_000;

  const skew = serverReceivedTime - clientSentTime;

  // Dead-band: leave the client's own event time alone under 60 s of skew.
  let corrected = Math.abs(skew) > SKEW_DEAD_BAND_MS ? clientEventTime + skew : clientEventTime;

  // Future-clamp: an event can never be dated after the server saw it.
  corrected = Math.min(corrected, serverReceivedTime);

  // Sanity clamp (guard 1): if the corrected time is more than the horizon away
  // from arrival, the client clock is not trustworthy — fall back to arrival.
  if (Math.abs(corrected - serverReceivedTime) > sanityMaxMs) {
    return { correctedTime: serverReceivedTime, timeFallback: true };
  }

  return { correctedTime: corrected, timeFallback: false };
}

/**
 * Monotonicity alarm (guard 2). A worker feeds each batch's observed
 * `server_received_time` here; a backward step between consecutive batches trips
 * the alarm exactly once per regression. Purely in-memory and single-worker
 * scoped — it detects the local stepped-clock symptom the slewing-daemon mandate
 * is supposed to prevent. Wiring the boolean to a real alert sink is ops-side.
 */
export class MonotonicityMonitor {
  private lastSeen: number | null = null;

  /**
   * Record the arrival time of the next batch. Returns true iff this arrival is
   * EARLIER than the previous one (the clock stepped backward → raise an alert).
   */
  observe(serverReceivedTime: number): boolean {
    const regressed = this.lastSeen !== null && serverReceivedTime < this.lastSeen;
    // Advance the high-water mark so a single dip alarms once, not forever.
    if (this.lastSeen === null || serverReceivedTime > this.lastSeen) {
      this.lastSeen = serverReceivedTime;
    }
    return regressed;
  }
}
