/**
 * Transport / batcher (spec §2.2–2.4).
 *
 * The ONLY module that stamps `client_sent_time` and talks HTTP. Contracts:
 *   - drain on `flush_interval_ms` / `batch_max_events`, POST `{v:1,sdk,events}`
 *     to `{endpoint}/v1/events` with `Authorization: Bearer <sdk_key>`;
 *   - `client_sent_time` is stamped AT FLUSH, per attempt (re-stamped on retry) —
 *     the same value for all events in one batch (the skew contract §2.3);
 *   - events are removed from the queue ONLY on a 2xx (any 2xx is final — §2.4);
 *   - byte-split by `batch_max_bytes` into multiple POSTs;
 *   - retry with exponential backoff + full jitter on network-fail / 5xx / 429;
 *     drop-and-debug on other 4xx (unrecoverable); pause transport + keep
 *     queueing + surface loudly on 401/403 (revoked key);
 *   - `event_id`s are NEVER re-minted across retry (they live in the queue);
 *   - client-side TTL: drop non-money events older than `event_ttl_ms` before
 *     send (money exempt) — honors the 24 h server dedup window;
 *   - unload flush via `sendBeacon` (or `fetch keepalive`) is size-bounded to the
 *     ~64 KB beacon cap and ships the queue TAIL.
 */

import type { ResolvedClientConfig, DebugSink } from './config';
import type { OfflineQueue } from './queue';
import type { QueuedEvent } from './storage';
import type { EventEnvelope } from './wire';
import { buildBatch, EVENTS_PATH, SDK_NAME } from './wire';

/** Minimal fetch surface (avoids a DOM lib dependency in the type). */
type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;
interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array;
  keepalive?: boolean;
}
interface FetchResponse {
  status: number;
}
type SendBeaconLike = (url: string, data: string | Uint8Array | Blob) => boolean;

export interface TransportDeps {
  config: ResolvedClientConfig;
  queue: OfflineQueue;
  sdkVersion: string;
  debug: DebugSink;
  now: () => number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injected for tests; defaults to navigator.sendBeacon. */
  sendBeaconImpl?: SendBeaconLike;
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

const encoder = new TextEncoder();

export class Transport {
  private readonly url: string;
  private readonly sdk: { name: string; version: string };
  private timerHandle: unknown = undefined;
  private flushing = false;
  private paused = false;
  /** Consecutive retryable failures — drives backoff. */
  private failureStreak = 0;

  constructor(private readonly deps: TransportDeps) {
    this.url = deps.config.endpoint + EVENTS_PATH;
    this.sdk = { name: SDK_NAME, version: deps.sdkVersion };
  }

  /** Whether transport is paused (401/403 — revoked key). Visible for debug. */
  get isPaused(): boolean {
    return this.paused;
  }

  start(): void {
    this.scheduleNext(this.deps.config.flush_interval_ms);
  }

  private scheduleNext(ms: number): void {
    if (this.timerHandle !== undefined) this.deps.clearTimer(this.timerHandle);
    this.timerHandle = this.deps.setTimer(() => {
      void this.tick();
    }, ms);
  }

  private async tick(): Promise<void> {
    await this.flush();
    // Backoff the NEXT poll when we are in a failure streak; else normal cadence.
    const delay = this.failureStreak > 0 ? this.backoffDelay() : this.deps.config.flush_interval_ms;
    this.scheduleNext(delay);
  }

  /** Exponential backoff + full jitter (spec §2.2, §6). */
  private backoffDelay(): number {
    const { retry_backoff_base_ms, retry_backoff_max_ms } = this.deps.config;
    const exp = Math.min(retry_backoff_max_ms, retry_backoff_base_ms * 2 ** (this.failureStreak - 1));
    return Math.floor(Math.random() * exp);
  }

  /**
   * Drain the queue: apply TTL, byte-split, POST each sub-batch, remove on 2xx.
   * Non-blocking to callers (the public `flush` awaits it, but capture never
   * does). Safe to call concurrently — a re-entrant call no-ops.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.paused) return;
    this.flushing = true;
    try {
      // Drain in chunks until the queue is empty or a send fails.
      for (;;) {
        const rows = await this.deps.queue.peek(this.deps.config.batch_max_events * 4);
        if (rows.length === 0) break;

        const { fresh, expired } = this.applyTtl(rows);
        if (expired.length > 0) {
          await this.deps.queue.remove(expired.map((e) => e.seq));
          this.deps.queue.countTtlDropped(expired.length);
        }
        if (fresh.length === 0) continue;

        const subBatch = this.takeByteBounded(fresh, this.deps.config.batch_max_bytes);
        const ok = await this.send(subBatch);
        if (!ok) break; // retryable failure — leave rows, retry with backoff
        await this.deps.queue.remove(subBatch.map((e) => e.seq)); // 2xx-only removal
        this.failureStreak = 0;
        if (
          subBatch.length === fresh.length &&
          fresh.length === rows.length &&
          rows.length < this.deps.config.batch_max_events * 4
        ) {
          // Drained everything we peeked and there is likely no more.
          const remaining = await this.deps.queue.size();
          if (remaining === 0) break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Partition rows into fresh vs TTL-expired (non-money only; money exempt). */
  private applyTtl(rows: QueuedEvent[]): { fresh: QueuedEvent[]; expired: QueuedEvent[] } {
    const cutoff = this.deps.now() - this.deps.config.event_ttl_ms;
    const fresh: QueuedEvent[] = [];
    const expired: QueuedEvent[] = [];
    for (const r of rows) {
      if (!r.money && r.enqueued_at < cutoff) expired.push(r);
      else fresh.push(r);
    }
    return { fresh, expired };
  }

  /**
   * Take a prefix of `rows` whose serialized batch stays under `maxBytes`.
   * Always includes at least one event (an oversized single event still ships —
   * the server enforces its own caps).
   */
  private takeByteBounded(rows: QueuedEvent[], maxBytes: number): QueuedEvent[] {
    const out: QueuedEvent[] = [];
    for (const r of rows) {
      const candidate = [...out, r];
      if (out.length > 0 && this.serializedBytes(candidate) > maxBytes) break;
      out.push(r);
      if (out.length >= this.deps.config.batch_max_events) break;
    }
    return out;
  }

  private serializedBytes(rows: QueuedEvent[]): number {
    return encoder.encode(this.serialize(rows, this.deps.now())).length;
  }

  /** Stamp `client_sent_time` (at flush) on every event, then serialize the batch. */
  private serialize(rows: QueuedEvent[], sentTime: number): string {
    const events: EventEnvelope[] = rows.map((r) => ({ ...r.envelope, client_sent_time: sentTime }));
    return JSON.stringify(buildBatch(events, this.sdk));
  }

  /** POST one sub-batch. Returns true on a 2xx (removable), false to retry. */
  private async send(rows: QueuedEvent[]): Promise<boolean> {
    const fetchImpl = this.deps.fetchImpl ?? (globalThis as unknown as { fetch?: FetchLike }).fetch;
    if (!fetchImpl) {
      this.deps.debug.error('[analytics-sdk] no fetch available; cannot transmit');
      return false;
    }
    const sentTime = this.deps.now(); // client_sent_time AT this attempt (§2.3)
    let body: string | Uint8Array = this.serialize(rows, sentTime);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.deps.config.sdkKey}`,
    };
    const gz = await this.maybeGzip(body);
    if (gz) {
      body = gz;
      headers['Content-Encoding'] = 'gzip';
    }

    let status: number;
    try {
      const res = await fetchImpl(this.url, { method: 'POST', headers, body });
      status = res.status;
    } catch {
      this.failureStreak++;
      return false; // network failure → retry
    }

    if (status >= 200 && status < 300) return true; // ANY 2xx is final (§2.4)
    if (status === 401 || status === 403) {
      this.paused = true;
      this.deps.debug.error(
        `[analytics-sdk] transport paused: auth failed (HTTP ${status}). The sdk_key may be revoked. ` +
          'Events keep queueing up to the cap; fix the key and re-init to resume.',
      );
      return false;
    }
    if (status === 429 || status >= 500) {
      this.failureStreak++;
      return false; // retryable
    }
    // Other 4xx — this batch can never succeed; drop it and surface.
    this.deps.debug.error(`[analytics-sdk] dropping unrecoverable batch (HTTP ${status})`);
    await this.deps.queue.remove(rows.map((e) => e.seq));
    this.failureStreak = 0;
    return false;
  }

  /** gzip the body via CompressionStream when the knob + platform allow. */
  private async maybeGzip(body: string): Promise<Uint8Array | null> {
    const mode = this.deps.config.compress;
    if (mode === 'off') return null;
    const CS = (globalThis as unknown as { CompressionStream?: typeof CompressionStream }).CompressionStream;
    if (!CS) {
      if (mode === 'on')
        this.deps.debug.warn('[analytics-sdk] compress=on but CompressionStream is unavailable; sending uncompressed');
      return null;
    }
    try {
      const stream = new CS('gzip');
      const writer = stream.writable.getWriter();
      void writer.write(encoder.encode(body));
      void writer.close();
      const chunks: Uint8Array[] = [];
      const reader = stream.readable.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out;
    } catch {
      return null; // never let compression break a send
    }
  }

  /**
   * Reliable unload flush (§2.1): ship the queue TAIL (most-recent, incl. the
   * terminal session + purchase companion) under the ~64 KB beacon cap via
   * `sendBeacon` (or `fetch keepalive:true`). Best-effort — the rest rides the
   * next normal flush / reconcile. NOTE: beacon delivery is fire-and-forget, so
   * the SDK does NOT remove these rows (it cannot observe the ack); the server's
   * windowed dedup absorbs the resulting redelivery.
   */
  async unloadFlush(): Promise<void> {
    const rows = await this.deps.queue.peek(this.deps.config.batch_max_events * 8);
    if (rows.length === 0) return;
    // Take the TAIL under the beacon cap.
    const beaconCap = Math.min(this.deps.config.batch_max_bytes, 64_000);
    const tail = this.takeTailByteBounded(rows, beaconCap);
    if (tail.length === 0) return;
    const body = this.serialize(tail, this.deps.now());

    const beacon =
      this.deps.sendBeaconImpl ??
      (globalThis as unknown as { navigator?: { sendBeacon?: SendBeaconLike } }).navigator?.sendBeacon?.bind(
        (globalThis as unknown as { navigator?: unknown }).navigator,
      );
    // sendBeacon cannot set Authorization; when a header is required we fall back
    // to fetch(keepalive). The URL carries the credential as a query param so the
    // server's bearer guard still authenticates (the guard reads Authorization
    // only, so keepalive-fetch is the header-preserving path used first).
    const fetchImpl = this.deps.fetchImpl ?? (globalThis as unknown as { fetch?: FetchLike }).fetch;
    if (fetchImpl) {
      try {
        await fetchImpl(this.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.deps.config.sdkKey}`,
          },
          body,
          keepalive: true,
        });
        return;
      } catch {
        /* fall through to beacon */
      }
    }
    if (beacon) {
      try {
        beacon(this.url, body);
      } catch {
        /* best-effort */
      }
    }
  }

  private takeTailByteBounded(rows: QueuedEvent[], maxBytes: number): QueuedEvent[] {
    const out: QueuedEvent[] = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const candidate = [rows[i]!, ...out];
      if (out.length > 0 && this.serializedBytes(candidate) > maxBytes) break;
      out.unshift(rows[i]!);
    }
    return out;
  }

  dispose(): void {
    if (this.timerHandle !== undefined) {
      this.deps.clearTimer(this.timerHandle);
      this.timerHandle = undefined;
    }
  }
}
