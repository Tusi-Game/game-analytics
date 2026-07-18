/**
 * GDPR/CCPA erasure job (T-00.72–77, ops-envelope §7) — the idempotent,
 * four-tier destructive job. One job, four tiers, SLA ≤ 30 days.
 *
 * Op-order (idempotent; re-runs are no-ops on absent rows/members):
 *   1. Verify + ledger `pending` (subject_ref = per-game KEYED HASH of user_id,
 *      NEVER plaintext — DARK-SPOT: no PII in Postgres).
 *   2. Read spine days FIRST (the bitmap must be read before anything deletes it).
 *   3. Any enumerated day unsealed → park `awaiting_seal`, re-evaluate ≤ 72 h.
 *   4. Destructive pass (all days sealed):
 *        tier (a) HARD-DELETE spine family + scrub membership + DETACH purchase
 *                 idempotency (delegated to TierADeletionPort);
 *                 002-owned IDENTITY_EDGE deleted directly here;
 *        tier (b) aggregate day cells LEFT UNTOUCHED (never recomputed — seal
 *                 invariant + legally unnecessary; enforced by simply NOT
 *                 touching EVENT_DAY_COUNT / EVENT_CATALOG / EXCEPTION_TALLY);
 *        tier (c) raw S3 files → retention-bounded expiry + ledger-refilter on
 *                 every rebuild (the ledger row IS the filter contract);
 *        tier (d) Redis → self-erasure by TTL behind this wait-for-seal gate
 *                 (NO Redis deletion code — the pass only runs post-seal).
 *   5. Ledger → `executed` + executed_at.
 *
 * Reconcile-forward-only (T-00.77): stored sealed cells are the post-erasure
 * truth; a re-appearing user_id is a NEW subject (no denylist, the ledger hash is
 * never consulted at ingest).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErasureLedgerEntity, type ErasureStatus } from '../database/entities/erasure-ledger.entity';
import { IdentityEdgeEntity } from '../database/entities/identity-edge.entity';
import { SubjectHashService } from '../security/subject-hash.service';
import { GameConfigService, GAME_CONFIG_DEFAULTS } from '../config/game-config.service';
import {
  SPINE_ENUMERATION_PORT,
  TIER_A_DELETION_PORT,
  type SpineEnumerationPort,
  type TierADeletionPort,
} from './erasure.ports';

export interface ErasureRequest {
  gameId: string;
  requestId: string;
  /** The subject's user_id — hashed to subject_ref immediately, never stored. */
  userId: string;
}

export interface ErasureResult {
  status: ErasureStatus;
  subjectRef: string;
  /** Days enumerated for the subject (empty in 002 scope). */
  days: string[];
}

@Injectable()
export class ErasureService {
  private readonly logger = new Logger(ErasureService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly subjectHash: SubjectHashService,
    private readonly gameConfig: GameConfigService,
    @Inject(SPINE_ENUMERATION_PORT) private readonly spine: SpineEnumerationPort,
    @Inject(TIER_A_DELETION_PORT) private readonly tierA: TierADeletionPort,
  ) {}

  /**
   * Execute (or advance) an erasure request. Safe to call repeatedly — the job
   * converges: pending → (awaiting_seal)* → executed, and every step is a no-op
   * if already done. An `executed` request returns immediately.
   */
  async erase(req: ErasureRequest): Promise<ErasureResult> {
    const subjectRef = this.subjectHash.subjectRef(req.gameId, req.userId);
    const ledgerRepo = this.dataSource.getRepository(ErasureLedgerEntity);

    // ---- 1. Ledger `pending` (idempotent upsert; keyed-hash subject_ref) ----
    const existing = await ledgerRepo.findOne({ where: { gameId: req.gameId, requestId: req.requestId } });
    if (existing?.status === 'executed') {
      // Already done — idempotent no-op. NEVER re-run the destructive pass.
      return { status: 'executed', subjectRef: existing.subjectRef, days: [] };
    }
    if (!existing) {
      await ledgerRepo.insert({
        gameId: req.gameId,
        requestId: req.requestId,
        requestedAt: new Date(),
        status: 'pending',
        executedAt: null,
        subjectRef, // per-game keyed hash — NEVER the plaintext user_id
      });
    }

    // ---- 2. Read spine days FIRST (before any delete touches the bitmap) -----
    const { days, allSealed } = await this.spine.enumerateDays(req.gameId, req.userId);

    // ---- 3. Any unsealed day → park awaiting_seal, re-evaluate later --------
    if (!allSealed) {
      await this.setStatus(req, subjectRef, 'awaiting_seal');
      this.logger.log(`[erasure] ${req.gameId}/${req.requestId} parked awaiting_seal (${days.length} days)`);
      return { status: 'awaiting_seal', subjectRef, days };
    }

    // ---- 4. Destructive pass (all days sealed) -----------------------------
    const purchaseMode = await this.readPurchaseMode(req.gameId);

    // tier (a): delegate the spine-family delete/scrub/detach (later specs).
    await this.tierA.deleteSpineFamily({ gameId: req.gameId, userId: req.userId, days, purchaseMode });

    // 002-owned: IDENTITY_EDGE holds (anon_id → user_id) — delete the subject's
    // edges directly (operational, not a spine tier). Idempotent (no rows → 0).
    await this.dataSource.getRepository(IdentityEdgeEntity).delete({ gameId: req.gameId, userId: req.userId });

    // tier (b): aggregate cells LEFT UNTOUCHED — nothing to do (the guard is
    // that we never write EVENT_DAY_COUNT/CATALOG/TALLY here). Documented no-op.
    // tier (c): raw expiry + ledger-refilter — the `executed` ledger row IS the
    // filter contract that every rebuild re-applies (ops-envelope §7.3); no hot
    // rewrite here. tier (d): Redis self-erases by TTL (no deletion code).

    // ---- 5. Ledger → executed ----------------------------------------------
    await this.setStatus(req, subjectRef, 'executed', new Date());
    this.logger.log(`[erasure] ${req.gameId}/${req.requestId} executed (subject_ref=${subjectRef.slice(0, 12)}…)`);
    return { status: 'executed', subjectRef, days };
  }

  /** Read the effective erasure purchase mode for a game (forward-only). */
  private async readPurchaseMode(gameId: string): Promise<'detach' | 'delete'> {
    const raw =
      (await this.gameConfig.getString(gameId, 'erasure_purchase_mode')) ?? GAME_CONFIG_DEFAULTS.erasure_purchase_mode;
    return raw === 'delete' ? 'delete' : 'detach';
  }

  /** Upsert the ledger status for a request (idempotent). */
  private async setStatus(
    req: ErasureRequest,
    subjectRef: string,
    status: ErasureStatus,
    executedAt: Date | null = null,
  ): Promise<void> {
    await this.dataSource
      .getRepository(ErasureLedgerEntity)
      .update({ gameId: req.gameId, requestId: req.requestId }, { status, executedAt });
    void subjectRef;
  }
}
