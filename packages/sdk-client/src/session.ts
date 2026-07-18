/**
 * Session tracker — the [003-sessions §1] executor (spec §2.1).
 *
 * [003-sessions §1] is NORMATIVE; this executes it, never redefines it:
 *   - Sessions start LAZILY at the first capture after init/expiry — init itself
 *     starts nothing.
 *   - Every capture sets `last_activity` and restarts the inactivity countdown,
 *     measured on **monotonic elapsed time** (a wall-clock jump or a throttled
 *     background timer never mis-splits a session; the boundary is recomputed
 *     from elapsed time at the next event/flush).
 *   - Exactly ONE terminal `kind=session` event is emitted at timeout
 *     (end = true `last_activity`, `reason=timeout`), on app-close
 *     (`reason=app_close`), or at reconcile (`reason=reconciled`), carrying
 *     `session_id`, `session_start_time`, `session_end_time`, `duration_ms`,
 *     `reason`. The open-session record is cleared only AFTER the terminal event
 *     is durably enqueued (the queue, not transmission, is the emission point).
 *   - Reconcile-at-init: if a persisted open-session record survives (killed app
 *     before the terminal event was enqueued), close it with the persisted
 *     `last_activity`, `reason=reconciled`. No session ever resumes across init.
 *
 * The tracker owns ALL session state and is the ONLY module that emits `session`
 * events. It calls back into the host to (a) enqueue an envelope and (b) mint the
 * session counter, so it needs no direct queue/identity coupling.
 */

import type { StorageAdapter } from './storage';
import { mintId } from './ids';

const K_OPEN_SESSION = 'open_session';

export type SessionEndReason = 'timeout' | 'app_close' | 'reconciled';

/** The persisted open-session record (§4). */
interface OpenSessionRecord {
  session_id: string;
  session_start_time: number;
  last_activity: number;
}

/** What the tracker asks the host to do when a session terminates. */
export interface SessionEmit {
  session_id: string;
  session_start_time: number;
  session_end_time: number;
  duration_ms: number;
  reason: SessionEndReason;
}

export interface SessionTrackerDeps {
  storage: StorageAdapter;
  /** Inactivity boundary in minutes (spec §6, default 30). */
  inactivityTimeoutMin: number;
  /** Wall clock (ms) for recorded timestamps. */
  now: () => number;
  /** Monotonic elapsed clock (ms). Defaults to `performance.now()` where present. */
  monotonic: () => number;
  /** Emit ONE terminal session envelope (durably enqueues it). */
  emitTerminal: (e: SessionEmit) => Promise<void>;
  /** Bump + return the lifetime session counter (called at each mint). */
  bumpCounter: () => Promise<number>;
  /** Schedule a timer; returns a handle. Injected for test control. */
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export class SessionTracker {
  private sessionId: string | undefined;
  private sessionStartTime = 0;
  private lastActivityWall = 0;
  /** Monotonic instant of the last activity — the inactivity basis. */
  private lastActivityMono = 0;
  private timerHandle: unknown = undefined;

  constructor(private readonly deps: SessionTrackerDeps) {}

  /** The current session id, if any (undefined between sessions). */
  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  private get timeoutMs(): number {
    return this.deps.inactivityTimeoutMin * 60_000;
  }

  private async readOpen(): Promise<OpenSessionRecord | null> {
    const raw = await this.deps.storage.getItem(K_OPEN_SESSION);
    if (!raw) return null;
    try {
      const p: unknown = JSON.parse(raw);
      if (
        p &&
        typeof p === 'object' &&
        typeof (p as OpenSessionRecord).session_id === 'string' &&
        typeof (p as OpenSessionRecord).session_start_time === 'number' &&
        typeof (p as OpenSessionRecord).last_activity === 'number'
      ) {
        return p as OpenSessionRecord;
      }
    } catch {
      /* corrupt record → treat as none */
    }
    return null;
  }

  private async writeOpen(rec: OpenSessionRecord): Promise<void> {
    await this.deps.storage.setItem(K_OPEN_SESSION, JSON.stringify(rec));
  }

  private async clearOpen(): Promise<void> {
    await this.deps.storage.removeItem(K_OPEN_SESSION);
  }

  /**
   * Reconcile at init: close any orphaned open session with the persisted
   * `last_activity` and `reason=reconciled`. Called once, from `init`, BEFORE the
   * first capture. If the terminal event was already enqueued before the kill, no
   * record exists and this is a no-op.
   */
  async reconcile(): Promise<void> {
    const rec = await this.readOpen();
    if (!rec) return;
    await this.deps.emitTerminal({
      session_id: rec.session_id,
      session_start_time: rec.session_start_time,
      session_end_time: rec.last_activity,
      duration_ms: Math.max(0, rec.last_activity - rec.session_start_time),
      reason: 'reconciled',
    });
    await this.clearOpen();
  }

  /**
   * Register a capture. Starts a session lazily if none is active (or the prior
   * one has expired on elapsed time), else refreshes `last_activity` + restarts
   * the inactivity timer. Returns the session id the capture belongs to.
   */
  async onCapture(): Promise<string> {
    const wall = this.deps.now();
    const mono = this.deps.monotonic();

    // Expire a stale session on ELAPSED time before deciding start-vs-continue.
    if (this.sessionId !== undefined && mono - this.lastActivityMono >= this.timeoutMs) {
      await this.endSession('timeout', this.lastActivityWall);
    }

    if (this.sessionId === undefined) {
      this.sessionId = mintId();
      this.sessionStartTime = wall;
      await this.deps.bumpCounter();
    }
    this.lastActivityWall = wall;
    this.lastActivityMono = mono;
    await this.writeOpen({
      session_id: this.sessionId,
      session_start_time: this.sessionStartTime,
      last_activity: this.lastActivityWall,
    });
    this.armTimer();
    return this.sessionId;
  }

  private armTimer(): void {
    if (this.timerHandle !== undefined) this.deps.clearTimer(this.timerHandle);
    this.timerHandle = this.deps.setTimer(() => {
      void this.onTimerFire();
    }, this.timeoutMs);
  }

  /** Timer callback: close on timeout IF the boundary truly elapsed (recompute). */
  private async onTimerFire(): Promise<void> {
    if (this.sessionId === undefined) return;
    const elapsed = this.deps.monotonic() - this.lastActivityMono;
    if (elapsed >= this.timeoutMs) {
      await this.endSession('timeout', this.lastActivityWall);
    } else {
      // Timer fired early (throttled/late-adjusted) — re-arm for the remainder.
      this.timerHandle = this.deps.setTimer(() => {
        void this.onTimerFire();
      }, this.timeoutMs - elapsed);
    }
  }

  /**
   * Emit the single terminal event and clear session state. `endWall` is the TRUE
   * end (last_activity for timeout/reconcile, now for app_close) — never inflated
   * to last_activity + timeout.
   */
  private async endSession(reason: SessionEndReason, endWall: number): Promise<void> {
    if (this.sessionId === undefined) return;
    const id = this.sessionId;
    const start = this.sessionStartTime;
    // Clear in-memory state first so a re-entrant capture starts a fresh session.
    this.sessionId = undefined;
    if (this.timerHandle !== undefined) {
      this.deps.clearTimer(this.timerHandle);
      this.timerHandle = undefined;
    }
    await this.deps.emitTerminal({
      session_id: id,
      session_start_time: start,
      session_end_time: endWall,
      duration_ms: Math.max(0, endWall - start),
      reason,
    });
    // Cleared ONLY after the terminal event is durably enqueued (§2.1).
    await this.clearOpen();
  }

  /** Explicit app-close (spec §5 `appClose`, browser lifecycle). end = now. */
  async close(reason: SessionEndReason = 'app_close'): Promise<void> {
    if (this.sessionId === undefined) return;
    await this.endSession(reason, this.deps.now());
  }

  /** Stop timers (shutdown). Does not emit. */
  dispose(): void {
    if (this.timerHandle !== undefined) {
      this.deps.clearTimer(this.timerHandle);
      this.timerHandle = undefined;
    }
  }
}
