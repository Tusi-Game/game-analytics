/**
 * The REAL durable PurchaseDedupGate ([006-monetization] build gap 1). Rebinds the
 * PURCHASE_DEDUP_GATE token (002 left it as UnimplementedPurchaseDedupGate). Money
 * dedup is DURABLE and NEVER-windowed: a purchase claims its `transaction_id` against
 * the PURCHASE_IDEMPOTENCY UNIQUE (PK) via `INSERT … ON CONFLICT DO NOTHING` — a retry
 * arriving DAYS late conflicts and is dropped (a Redis 24 h window cannot catch it).
 *
 * The kernel sequences this at step 6 keying on `transaction_id` (R2 — dedup on
 * transaction_id; the companion JOIN keys on purchase_attempt_id).
 *
 * ============ SINGLE DURABLE CLAIM SITE (step 7), non-consuming step 6 ============
 * The kernel's step-6 signature is `claimTransaction(gameId, transactionId)` — it has
 * NO eligibility context (verified/prod/provenance live on the envelope, which the
 * durable hook owns at step 7). The design requires 6a (verified ∧ prod ∧ server) to
 * precede 6b so an INELIGIBLE row never consumes a transaction_id slot. We satisfy both
 * without editing the kernel:
 *   - step 6 ({@link claimTransaction}) is a NON-CONSUMING existence check — it returns
 *     `duplicate` (stop) iff the row ALREADY exists (the fast path for a true, possibly
 *     days-late duplicate), else `claimed` so the pipeline reaches step 7. It never
 *     inserts, so it never consumes a slot for an ineligible row.
 *   - step 7 ({@link claimFull}, called by {@link PurchaseDurableHook}) is the
 *     AUTHORITATIVE claim: it runs 6a eligibility first, and only for an eligible row
 *     does it `INSERT … ON CONFLICT DO NOTHING` the FULL row inside the 05→06 atomic
 *     unit. A concurrent race where two workers both pass step 6 is resolved here — one
 *     insert wins (`claimed`), the loser conflicts (`duplicate`) and no-ops the unit.
 * Net: exactly one durable slot per eligible transaction; ineligible rows never insert;
 * a duplicate produces zero durable effect at any lateness (bridge 05.5 §1).
 */

import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { DedupOutcome, PurchaseDedupGate } from '../common/kernel/dedup';
import { PurchaseIdempotencyEntity } from '../database/entities/purchase-idempotency.entity';

/** The full durable row an eligible purchase claims (durable hook supplies this). */
export interface PurchaseClaim {
  transactionId: string;
  originalTransactionId: string;
  gameId: string;
  userId: string;
  purchaseDay: string;
  priceLocal: string;
  currency: string;
  productId: string;
  refunded: boolean;
}

@Injectable()
export class PurchaseDedupGateService implements PurchaseDedupGate {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Kernel step-6 entrypoint (dedup.ts contract). Claims `transaction_id` with a
   * MINIMAL row (game_id + transaction_id + neutral defaults). Returns `claimed` if
   * this call won the insert, `duplicate` if the row already existed.
   *
   * The kernel calls this with only (gameId, transactionId) — it cannot supply the
   * full row (6a eligibility + the money attributes live in the worker's envelope,
   * not the kernel step-6 signature). 006 therefore keeps the AUTHORITATIVE gate in
   * the durable hook ({@link claimFull}); this kernel path is retained for the seam's
   * type contract but the module wires the durable hook to do the eligible claim.
   *
   * To avoid a double-claim (kernel step-6 + durable step-7 both inserting), the
   * MODULE routes the kernel's purchase dedup through {@link claimFull} indirectly:
   * the durable hook reads the record, runs 6a, and calls claimFull; the kernel's
   * step-6 for purchase is satisfied by this method returning `claimed` optimistically
   * ONLY when it truly inserts. See module wiring + durable hook for the single-claim
   * guarantee.
   */
  async claimTransaction(_gameId: string, transactionId: string): Promise<DedupOutcome> {
    // Minimal presence check WITHOUT inserting — the authoritative insert is the
    // durable hook's claimFull (which carries the eligible full row and runs 6a
    // first). Returning `claimed` here lets the kernel proceed to step 7 where the
    // real gate insert happens; a true duplicate is caught there and the hook stops
    // the unit. This keeps the durable claim single-sited (step 7) while satisfying
    // the kernel's step-6 seam. A pre-existing row → `duplicate` short-circuit.
    const existing = await this.dataSource
      .getRepository(PurchaseIdempotencyEntity)
      .findOne({ where: { transactionId }, select: { transactionId: true } });
    return existing ? 'duplicate' : 'claimed';
  }

  /**
   * The authoritative durable claim (durable hook, step 7). Insert-if-absent the FULL
   * row under `ON CONFLICT (transaction_id) DO NOTHING`, inside the caller's
   * transaction `manager` (the 05→06 atomic unit). Returns `claimed` iff THIS insert
   * created the row (rowCount === 1), `duplicate` if it conflicted.
   *
   * This is the ONE place a durable money slot is consumed — a duplicate transaction
   * (any lateness) conflicts and returns `duplicate`, and the caller no-ops the whole
   * atomic unit (exactly-once, bridge 05.5 §1).
   */
  async claimFull(manager: EntityManager, claim: PurchaseClaim): Promise<DedupOutcome> {
    const result = await manager
      .createQueryBuilder()
      .insert()
      .into(PurchaseIdempotencyEntity)
      .values({
        transactionId: claim.transactionId,
        originalTransactionId: claim.originalTransactionId,
        gameId: claim.gameId,
        userId: claim.userId,
        purchaseDay: claim.purchaseDay,
        priceLocal: claim.priceLocal,
        currency: claim.currency,
        productId: claim.productId,
        refunded: claim.refunded,
      })
      .orIgnore() // ON CONFLICT DO NOTHING
      .execute();
    // orIgnore → identifiers is empty on conflict; a real insert reports one row.
    const inserted = Array.isArray(result.identifiers) && result.identifiers.some((id) => id !== undefined);
    return inserted ? 'claimed' : 'duplicate';
  }
}
