/**
 * Bounded in-memory outbound queue with MONEY-AWARE overflow (spec §4, §6).
 *
 * No durable spool in v1 (accepted — a crash loses the un-acked queue; recovery
 * is re-emit from the game backend's payment records, safe under durable
 * `transaction_id` dedup, and `flush_on_purchase` shrinks the window).
 *
 * Overflow policy:
 *   - a non-purchase event beyond the bound is DROPPED-and-counted (surfaced via
 *     `on_error`, never thrown);
 *   - a `verifiedPurchase` that cannot be enqueued throws {@link QueueOverflowError}
 *     SYNCHRONOUSLY to the caller — money is never silently dropped.
 */

import type { BuiltEnvelope } from './envelope-builder';
import type { EventEnvelope } from './wire';

/** Thrown synchronously when a money-bearing event cannot be enqueued. */
export class QueueOverflowError extends Error {
  constructor() {
    super(
      '[analytics-sdk-server] outbound queue is full and this is a verified purchase — ' +
        'money must not be silently dropped. Increase queue_max_events or investigate why flushes are failing. ' +
        're-emit is safe (durable transaction_id dedup).',
    );
    this.name = 'QueueOverflowError';
  }
}

export interface OutboundRow {
  seq: number;
  envelope: BuiltEnvelope;
  /** True for verified-purchase rows — protected from silent drop. */
  money: boolean;
}

export class OutboundQueue {
  private rows: OutboundRow[] = [];
  private nextSeq = 1;
  private _nonMoneyDropped = 0;

  constructor(private readonly cap: number) {}

  get nonMoneyDropped(): number {
    return this._nonMoneyDropped;
  }

  /**
   * Enqueue an event. Non-money overflow is dropped-and-counted (returns the
   * count dropped); money overflow throws {@link QueueOverflowError}.
   */
  enqueue(envelope: BuiltEnvelope, money: boolean): number {
    let dropped = 0;
    if (this.rows.length >= this.cap) {
      if (money) {
        // Try to make room by dropping the OLDEST NON-money row; if none exists,
        // the whole queue is money — refuse synchronously rather than lose it.
        const idx = this.rows.findIndex((r) => !r.money);
        if (idx === -1) throw new QueueOverflowError();
        this.rows.splice(idx, 1);
        dropped++;
        this._nonMoneyDropped++;
      } else {
        // Non-money overflow: drop THIS event (do not evict a queued one that may
        // be money) — count it and return.
        this._nonMoneyDropped++;
        return 1;
      }
    }
    this.rows.push({ seq: this.nextSeq++, envelope, money });
    return dropped;
  }

  /** Oldest `limit` rows, FIFO. */
  peek(limit: number): OutboundRow[] {
    return this.rows.slice(0, limit);
  }

  /** Remove rows by seq (post-2xx or retry-budget-exhausted). */
  remove(seqs: number[]): void {
    const drop = new Set(seqs);
    this.rows = this.rows.filter((r) => !drop.has(r.seq));
  }

  size(): number {
    return this.rows.length;
  }
}

/** The wire-shaped envelope a row serializes to (client_sent_time added at flush). */
export function toWire(row: OutboundRow, clientSentTime: number): EventEnvelope {
  return { ...(row.envelope as unknown as EventEnvelope), client_sent_time: clientSentTime };
}
