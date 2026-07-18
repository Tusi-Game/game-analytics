/**
 * Dedup — two regimes, NEVER mixed (foundation §4.1, P5). DARK-SPOT #8.
 *
 *   WINDOWED (this file, 002-owned) — `generic` / `economy` / `session`:
 *     `{game_id}:dedup:{event_id}` claimed via SETNX with a FIXED 24 h TTL. A
 *     duplicate within 24 h is a no-op; a repeat beyond the window MAY
 *     double-count — accepted for non-money.
 *
 *   DURABLE (006-owned) — `purchase` (money):
 *     `PURCHASE_IDEMPOTENCY.transaction_id` UNIQUE, insert-if-absent in Postgres.
 *     A retry arriving DAYS late never double-counts. NEVER expressed as a time
 *     window. 002 only SEQUENCES this gate in step 6 (calls the port); it does
 *     NOT build the table. Money must NEVER be routed through the 24 h window —
 *     a >24 h retry through the window would double-count money.
 *
 * The two are kept as separate mechanisms behind separate types so a caller
 * physically cannot route a purchase through the windowed gate.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { IngestKeys } from '../redis-keys/redis-keys';
import { DEDUP_TTL_SECONDS } from '../redis-keys/ttl';

/** Outcome of a dedup claim: `claimed` = first sighting; `duplicate` = suppress. */
export type DedupOutcome = 'claimed' | 'duplicate';

/**
 * Windowed dedup gate (002 / front-door owned). Claims the `event_id` marker
 * with a fixed 24 h TTL BEFORE any counter/spine/hot write (step 6), so
 * raw-append (step 4) + this claim form one recovery unit: a stalled re-run that
 * died after step 4 but before claiming re-appends (harmless) and re-claims; a
 * re-run that died after claiming stops on the marker. The failure direction is
 * always the safe one — at most an UNDERCOUNT, never a double-count.
 */
@Injectable()
export class WindowedDedupGate {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Atomically claim `event_id` for `game_id`. `SET key 1 NX EX 86400` — the
   * claim and the TTL are set in one round-trip so a crash can never leave a
   * marker with no expiry.
   *
   * @returns `claimed` if this call won the marker (process the event);
   *          `duplicate` if a live marker already existed (stop).
   */
  async claim(gameId: string, eventId: string): Promise<DedupOutcome> {
    const key = IngestKeys.dedup(gameId, eventId);
    // NX → only sets if absent; EX → the fixed 24 h window. One atomic command.
    const res = await this.redis.set(key, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
    return res === 'OK' ? 'claimed' : 'duplicate';
  }
}

/**
 * Injection token for the {@link PurchaseDedupGate} port. 002 binds a
 * throw-on-use placeholder so the kernel step-6 sequencing compiles and the
 * seam is testable; 006-monetization overrides this provider with the real
 * durable `transaction_id` insert-if-absent implementation.
 */
export const PURCHASE_DEDUP_GATE = 'PURCHASE_DEDUP_GATE';

/**
 * The DURABLE purchase-dedup seam (006 implements). A purchase claims its
 * `transaction_id` against the Postgres UNIQUE key. This is a PORT only — 002
 * sequences the call in step 6 but never touches the money table, and money
 * NEVER flows through {@link WindowedDedupGate}.
 */
export interface PurchaseDedupGate {
  /**
   * Insert-if-absent the durable transaction key.
   * @returns `claimed` if the row was newly inserted (process the purchase);
   *          `duplicate` if the `transaction_id` already existed (stop).
   */
  claimTransaction(gameId: string, transactionId: string): Promise<DedupOutcome>;
}

/**
 * The Unit-2 placeholder bound at {@link PURCHASE_DEDUP_GATE}. It exists so the
 * kernel wiring is complete and DI-resolvable before 006 lands; invoking it is a
 * hard error, making "purchases silently un-deduped" impossible to ship.
 */
@Injectable()
export class UnimplementedPurchaseDedupGate implements PurchaseDedupGate {
  claimTransaction(_gameId: string, _transactionId: string): Promise<DedupOutcome> {
    return Promise.reject(
      new Error(
        '[dedup] PurchaseDedupGate is a seam owned by 006-monetization (durable transaction_id). ' +
          'It is not implemented in 002. Money must never use the 24 h windowed gate.',
      ),
    );
  }
}
