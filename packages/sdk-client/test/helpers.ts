/**
 * Test helpers: a fake clock/monotonic pair, a controllable timer scheduler, and
 * a mock ingest server that records every batch it receives. Golden emissions
 * carry STATIC ids, so assertions compare SHAPE + field-names + fixed non-id
 * fields — never the exact minted ids (which the SDK generates fresh).
 */

import type { ClientTestHooks } from '../src/client';

/** A wire event as seen on the recorded batch — loose so tests index freely. */
export interface WireEvent {
  event_id?: string;
  user_id?: string;
  anon_id?: string;
  session_id?: string;
  name?: string;
  kind?: string;
  client_event_time?: number;
  client_sent_time?: number;
  props: Record<string, unknown>;
  [key: string]: unknown;
}
/** A wire batch as recorded by the mock ingest. */
export interface WireBatch {
  v?: number;
  sdk: { name: string; version: string };
  events: WireEvent[];
}

/** A monotonic + wall clock the test drives explicitly. */
export class FakeClock {
  private wallMs: number;
  private monoMs = 0;
  constructor(startWallMs = 1_752_840_000_000) {
    this.wallMs = startWallMs;
  }
  now = (): number => this.wallMs;
  monotonic = (): number => this.monoMs;
  /** Advance BOTH clocks by `ms` (wall + monotonic move together by default). */
  advance(ms: number): void {
    this.wallMs += ms;
    this.monoMs += ms;
  }
  /** Advance ONLY the wall clock (simulate a clock jump; monotonic unaffected). */
  advanceWallOnly(ms: number): void {
    this.wallMs += ms;
  }
}

interface ScheduledTimer {
  id: number;
  fireAtMono: number;
  cb: () => void;
}

/**
 * A timer scheduler bound to a FakeClock's monotonic time. `runDue()` fires every
 * timer whose deadline has passed, honoring re-arms.
 */
export class FakeTimers {
  private timers: ScheduledTimer[] = [];
  private nextId = 1;
  constructor(private readonly clock: FakeClock) {}

  setTimer = (cb: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.push({ id, fireAtMono: this.clock.monotonic() + ms, cb });
    return id;
  };
  clearTimer = (handle: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== handle);
  };
  /** Fire all timers due at the clock's current monotonic instant (drains re-arms). */
  runDue(): void {
    for (let guard = 0; guard < 1000; guard++) {
      const due = this.timers
        .filter((t) => t.fireAtMono <= this.clock.monotonic())
        .sort((a, b) => a.fireAtMono - b.fireAtMono);
      if (due.length === 0) return;
      const t = due[0]!;
      this.timers = this.timers.filter((x) => x.id !== t.id);
      t.cb();
    }
  }
}

/** A mock ingest server whose status can be scripted per attempt. */
export class MockIngest {
  readonly posts: { url: string; batch: WireBatch; headers: Record<string, string>; keepalive: boolean }[] = [];
  private statusQueue: number[] = [];
  private defaultStatus = 200;

  /** Script the next N statuses (e.g. [500, 500, 200]); after the queue, default. */
  scriptStatuses(...statuses: number[]): void {
    this.statusQueue = statuses;
  }
  setDefaultStatus(status: number): void {
    this.defaultStatus = status;
  }

  fetchImpl = async (url: string, init: unknown): Promise<{ status: number }> => {
    const i = init as { headers?: Record<string, string>; body?: string; keepalive?: boolean };
    let batch: WireBatch;
    try {
      batch = JSON.parse(String(i.body)) as WireBatch;
    } catch {
      batch = { sdk: { name: '?', version: '?' }, events: [] };
    }
    this.posts.push({ url, batch, headers: i.headers ?? {}, keepalive: i.keepalive ?? false });
    const status = this.statusQueue.length > 0 ? this.statusQueue.shift()! : this.defaultStatus;
    return { status };
  };

  /** Every event across every recorded POST, in order. */
  allEvents(): WireEvent[] {
    return this.posts.flatMap((p) => p.batch.events);
  }
}

/** Flush pending microtasks + macrotasks so floated async chains settle. */
export async function settle(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Assemble the ClientTestHooks a test drives. */
export function makeHooks(clock: FakeClock, timers: FakeTimers, ingest: MockIngest): ClientTestHooks {
  return {
    now: clock.now,
    monotonic: clock.monotonic,
    timers: { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
    fetchImpl: ingest.fetchImpl,
  };
}
