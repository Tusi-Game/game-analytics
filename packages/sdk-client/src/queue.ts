/**
 * Persistent bounded offline queue (spec §2.2, §4).
 *
 * Wraps the storage adapter with the queue POLICY: bounded to
 * `offline_queue_max_events`, drop-oldest at the cap, with a visible
 * `queue_overflow` drop counter. Writes never throw into game code — a
 * quota/write failure evicts-oldest-and-counts (delegated to the adapter).
 *
 * The queue is the emission point (§2.1): a capture returns only after its
 * envelope is durably enqueued here. Removal happens only on a 2xx ack, or on a
 * TTL / unrecoverable-4xx drop.
 */

import type { StorageAdapter, QueuedEvent } from './storage';
import type { CapturedEnvelope } from './envelope-factory';
import type { EventEnvelope } from './wire';

export interface QueueStats {
  /** Total events dropped due to the cap or a write failure (visible in debug). */
  overflowDropped: number;
  /** Total non-money events dropped by the client-side TTL before send. */
  ttlDropped: number;
}

export class OfflineQueue {
  private _overflowDropped = 0;
  private _ttlDropped = 0;

  constructor(
    private readonly storage: StorageAdapter,
    private readonly cap: number,
  ) {}

  get stats(): QueueStats {
    return { overflowDropped: this._overflowDropped, ttlDropped: this._ttlDropped };
  }

  /**
   * Durably append a captured envelope. `money=true` marks the purchase
   * companion — but note the companion carries ZERO money and IS TTL-exempt only
   * as a policy choice; the client TTL only ever drops non-money events.
   * Returns after the write completes (the call-site's "durable enqueue").
   */
  async enqueue(envelope: CapturedEnvelope, money: boolean, now: number): Promise<void> {
    // The queue stores the captured envelope as an EventEnvelope-shaped row; the
    // transport fills client_sent_time at flush. game_id/server_received_time are
    // never present (envelope factory excludes them).
    const dropped = await this.storage.push(
      { envelope: envelope as unknown as EventEnvelope, enqueued_at: now, money },
      this.cap,
    );
    this._overflowDropped += dropped;
  }

  /** Oldest `limit` queued events, FIFO. */
  async peek(limit: number): Promise<QueuedEvent[]> {
    return this.storage.peek(limit);
  }

  /** Remove events by seq (post-2xx or drop). */
  async remove(seqs: number[]): Promise<void> {
    await this.storage.remove(seqs);
  }

  /** Count a batch of non-money events dropped by the client-side TTL. */
  countTtlDropped(n: number): void {
    this._ttlDropped += n;
  }

  async size(): Promise<number> {
    return this.storage.size();
  }
}
