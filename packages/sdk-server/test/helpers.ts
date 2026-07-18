/**
 * Server SDK test helpers: a fake clock, a no-op sleep (so backoff never really
 * waits), and a mock ingest server whose statuses can be scripted per attempt.
 */

/** A wire event as recorded — loose so tests index freely. */
export interface WireEvent {
  event_id?: string;
  user_id?: string;
  name?: string;
  kind?: string;
  session_id?: string;
  client_event_time?: number;
  client_sent_time?: number;
  props: Record<string, unknown>;
  [key: string]: unknown;
}
export interface WireBatch {
  v?: number;
  sdk: { name: string; version: string };
  events: WireEvent[];
}

export class FakeClock {
  private ms: number;
  constructor(startMs = 1_752_840_000_000) {
    this.ms = startMs;
  }
  now = (): number => this.ms;
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** A sleep that advances a FakeClock instead of really waiting. */
export function fakeSleep(clock: FakeClock): (ms: number) => Promise<void> {
  return (ms: number) => {
    clock.advance(ms);
    return Promise.resolve();
  };
}

export class MockIngest {
  readonly posts: { url: string; batch: WireBatch; headers: Record<string, string> }[] = [];
  private statusQueue: number[] = [];
  private defaultStatus = 200;

  scriptStatuses(...statuses: number[]): void {
    this.statusQueue = statuses;
  }
  setDefaultStatus(status: number): void {
    this.defaultStatus = status;
  }

  fetchImpl = async (url: string, init: unknown): Promise<{ status: number }> => {
    const i = init as { headers?: Record<string, string>; body?: string };
    let batch: WireBatch;
    try {
      batch = JSON.parse(String(i.body)) as WireBatch;
    } catch {
      batch = { sdk: { name: '?', version: '?' }, events: [] };
    }
    this.posts.push({ url, batch, headers: i.headers ?? {} });
    const status = this.statusQueue.length > 0 ? this.statusQueue.shift()! : this.defaultStatus;
    return { status };
  };

  allEvents(): WireEvent[] {
    return this.posts.flatMap((p) => p.batch.events);
  }
}
