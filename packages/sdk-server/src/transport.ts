/**
 * Transport / batcher (spec §2.3–2.6). Node-side, plain bearer over TLS.
 *
 *   - batch (`batch_max_events`), POST `{v:1, sdk, events}` to
 *     `{endpoint}/v1/events` with `Authorization: Bearer <server_credential>`;
 *   - one `client_sent_time` stamped at flush per batch (§2.5);
 *   - at-least-once: network-fail / non-2xx retries under capped exponential
 *     backoff + jitter, up to a per-batch `retry_max_elapsed_ms` budget; on
 *     exhaustion the events are surfaced to `on_error` and dropped from the queue
 *     (the caller re-emits — safe under durable dedup);
 *   - ANY 2xx (incl. quarantine-ack) is FINAL (§2.4);
 *   - `event_id`s are NEVER re-minted across retry (they live on the queued row).
 *
 * Emit calls never touch this on the hot path — the batcher runs on a timer and
 * on explicit flush. All failures route to `on_error`, never thrown into caller
 * code (contract 9 — analytics never breaks checkout).
 */

import type { ResolvedServerConfig } from './config';
import type { OutboundQueue, OutboundRow } from './queue';
import { toWire } from './queue';
import { buildBatch, EVENTS_PATH, SDK_NAME } from './wire';
import { SDK_VERSION } from './version';

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ status: number }>;

export interface ServerTransportDeps {
  config: ResolvedServerConfig;
  queue: OutboundQueue;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  fetchImpl?: FetchLike;
}

export class ServerTransport {
  private readonly url: string;
  private readonly sdk: { name: string; version: string };
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;

  constructor(private readonly deps: ServerTransportDeps) {
    this.url = deps.config.endpoint + EVENTS_PATH;
    this.sdk = { name: SDK_NAME, version: SDK_VERSION };
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.deps.config.flush_interval_ms);
    // Do not keep the Node event loop alive just for flushing.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Drain the queue. Resolves once the queue is empty or a batch exhausts its
   * retry budget. Safe to call concurrently — a re-entrant call awaits nothing
   * and returns.
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (;;) {
        const rows = this.deps.queue.peek(this.deps.config.batch_max_events);
        if (rows.length === 0) break;
        const delivered = await this.deliverWithRetry(rows);
        // Whether 2xx (delivered) or budget-exhausted (surfaced), the rows leave
        // the queue — at-least-once means the caller re-emits on true loss.
        this.deps.queue.remove(rows.map((r) => r.seq));
        if (!delivered) break; // stop draining after a budget exhaustion
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Deliver one batch, retrying until 2xx or the elapsed budget is spent. */
  private async deliverWithRetry(rows: OutboundRow[]): Promise<boolean> {
    const started = this.deps.now();
    let attempt = 0;
    for (;;) {
      const outcome = await this.attempt(rows);
      if (outcome === 'ok') return true;
      if (outcome === 'drop') return false; // unrecoverable 4xx — surfaced, drop
      attempt++;
      const elapsed = this.deps.now() - started;
      if (elapsed >= this.deps.config.retry_max_elapsed_ms) {
        this.deps.config.on_error(
          new Error(
            `[analytics-sdk-server] retry budget exhausted after ${elapsed}ms; ${rows.length} event(s) not delivered`,
          ),
          {
            fatal: false,
            detail: "re-emit is safe under durable transaction_id dedup; events are the caller's to re-send",
          },
        );
        return false;
      }
      await this.deps.sleep(this.backoffDelay(attempt, elapsed));
    }
  }

  /** One POST attempt. `client_sent_time` is stamped HERE (per attempt). */
  private async attempt(rows: OutboundRow[]): Promise<'ok' | 'retry' | 'drop'> {
    const fetchImpl = this.deps.fetchImpl ?? (globalThis as unknown as { fetch?: FetchLike }).fetch;
    if (!fetchImpl) {
      this.deps.config.on_error(new Error('[analytics-sdk-server] no fetch available (Node < 18?)'), { fatal: true });
      return 'drop';
    }
    const sentTime = this.deps.now();
    const events = rows.map((r) => toWire(r, sentTime));
    const body = JSON.stringify(buildBatch(events, this.sdk));
    let status: number;
    try {
      const res = await fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.deps.config.serverCredential}`,
        },
        body,
      });
      status = res.status;
    } catch (err) {
      if (this.deps.config.debug) this.deps.config.on_error(err, { fatal: false, detail: 'network error; will retry' });
      return 'retry';
    }
    if (status >= 200 && status < 300) return 'ok'; // any 2xx is final
    if (status === 429 || status >= 500) return 'retry';
    // Other 4xx (incl. 401/403) — cannot succeed; surface and drop.
    this.deps.config.on_error(new Error(`[analytics-sdk-server] non-retryable HTTP ${status}; dropping batch`), {
      fatal: status === 401 || status === 403,
      detail: status === 401 || status === 403 ? 'server_credential may be invalid/revoked' : undefined,
    });
    return 'drop';
  }

  private backoffDelay(attempt: number, elapsed: number): number {
    const { retry_backoff_base_ms, retry_backoff_max_ms, retry_max_elapsed_ms } = this.deps.config;
    const exp = Math.min(retry_backoff_max_ms, retry_backoff_base_ms * 2 ** (attempt - 1));
    const jittered = Math.floor(Math.random() * exp);
    // Never sleep past the remaining budget.
    return Math.max(0, Math.min(jittered, retry_max_elapsed_ms - elapsed));
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
