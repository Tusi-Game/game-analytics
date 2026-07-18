/**
 * GDPR admin surface (T-10.29-32) — the operator-facing trigger layer OVER 002's
 * jobs. This module does NOT reimplement erasure/DSAR (that is GdprModule's
 * ErasureService / DsarService); it SURFACES them behind operator attestation +
 * audit.
 *
 * Why attestation (T-10.29/31): identity verification is the studio's manual duty
 * (mirroring Matomo) — the platform cannot prove the requester is the subject. An
 * erasure destroys data and a DSAR-access export is a full per-user dump, so an
 * over-trusted surface is a data-exfil risk (tasks §4). Every trigger requires
 * admin RBAC (enforced at the controller) AND records an attestation row
 * (GDPR_REQUEST_AUDIT) with the attesting operator, keyed subject_ref (never
 * plaintext user_id), attestation note, and outcome.
 *
 * awaiting_seal stuck-flag (T-10.30): an erasure parks `awaiting_seal` when an
 * enumerated day stays unsealed because the id keeps generating activity
 * (account deletion in the game must precede analytics erasure). This service
 * surfaces those stuck requests so the operator can act (ops-envelope §7.5 step 3).
 *
 * Art. 11 boundary (T-10.32): already carried in the DSAR export's `scope_note`
 * (DsarService) — this surface returns the assembled export verbatim, so the
 * boundary statement is delivered to the operator/subject.
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { ErasureService, type ErasureResult } from '../gdpr/erasure.service';
import { DsarService, type DsarExport } from '../gdpr/dsar.service';
import { SubjectHashService } from '../security/subject-hash.service';
import { ErasureLedgerEntity } from '../database/entities/erasure-ledger.entity';
import { GdprRequestAuditEntity, type GdprRequestKind } from '../database/entities/gdpr-request-audit.entity';

/** One row of the GDPR request-history read (over GDPR_REQUEST_AUDIT). */
export interface GdprAuditRow {
  auditId: string;
  gameId: string;
  operatorId: string;
  kind: GdprRequestKind;
  /** Keyed subject hash — NEVER the plaintext user_id (P13). */
  subjectRef: string;
  attestation: string;
  outcome: string;
  requestedAt: Date;
}

/** An operator-attested GDPR request (identity verified out-of-band by the studio). */
export interface AttestedGdprRequest {
  gameId: string;
  /** The subject's user_id (hashed to subject_ref for the audit; passed to the job). */
  userId: string;
  /** The operator's attestation note (what verification was performed). Required. */
  attestation: string;
  /** The attesting operator (from the session). */
  operatorId: string;
}

/** A surfaced erasure request stuck in `awaiting_seal` (T-10.30). */
export interface StuckErasureRequest {
  gameId: string;
  requestId: string;
  subjectRef: string;
  requestedAt: Date;
  status: string;
}

@Injectable()
export class GdprAdminService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly erasure: ErasureService,
    private readonly dsar: DsarService,
    private readonly subjectHash: SubjectHashService,
  ) {}

  /**
   * Operator-verified ERASURE trigger (T-10.29). Records the attestation, then
   * invokes 002's ErasureService.erase() → creates/advances the ERASURE_LEDGER
   * row (pending → awaiting_seal → executed). Returns the job result.
   */
  async triggerErasure(req: AttestedGdprRequest): Promise<ErasureResult> {
    this.assertAttested(req);
    const requestId = randomUUID();
    const result = await this.erasure.erase({ gameId: req.gameId, requestId, userId: req.userId });
    await this.audit(req, 'erasure', result.status);
    return result;
  }

  /**
   * Operator-verified DSAR-access / portability trigger (T-10.31). Same
   * attestation path; invokes 002's DsarService.assemble() → the machine-readable
   * export (Art. 15/20) with the Art. 11 boundary in its scope_note (T-10.32).
   */
  async triggerDsar(req: AttestedGdprRequest): Promise<DsarExport> {
    this.assertAttested(req);
    const export_ = await this.dsar.assemble(req.gameId, req.userId);
    await this.audit(req, 'dsar_access', 'assembled');
    return export_;
  }

  /**
   * Surface erasure requests stuck in `awaiting_seal` (T-10.30). Optionally scoped
   * to one game (P12 — per-game views never cross games); omit gameId to list all
   * games the operator administers (cross-game ACCESS, still one game per row).
   */
  async listStuckAwaitingSeal(gameId?: string): Promise<StuckErasureRequest[]> {
    const repo = this.dataSource.getRepository(ErasureLedgerEntity);
    const where =
      gameId !== undefined ? { gameId, status: 'awaiting_seal' as const } : { status: 'awaiting_seal' as const };
    const rows = await repo.find({ where, order: { requestedAt: 'ASC' } });
    return rows.map((r) => ({
      gameId: r.gameId,
      requestId: r.requestId,
      subjectRef: r.subjectRef,
      requestedAt: r.requestedAt,
      status: r.status,
    }));
  }

  /**
   * SYNCHRONOUS-model request history (T-11.76/77): the panel's erasure/DSAR
   * flows run INLINE (there is no async job queue / download-token layer), so the
   * "history" surface is a read over the GDPR_REQUEST_AUDIT attestation trail —
   * one row per triggered erasure/DSAR with the attesting operator, keyed subject
   * ref (never plaintext), and outcome. Scoped to one game (P12), newest first.
   */
  async listGdprAudit(gameId: string, kind?: GdprRequestKind, limit = 100): Promise<GdprAuditRow[]> {
    const where = kind !== undefined ? { gameId, kind } : { gameId };
    const rows = await this.dataSource.getRepository(GdprRequestAuditEntity).find({
      where,
      order: { requestedAt: 'DESC' },
      take: Math.min(Math.max(1, limit), 1000),
    });
    return rows.map((r) => ({
      auditId: r.auditId,
      gameId: r.gameId,
      operatorId: r.operatorId,
      kind: r.kind,
      subjectRef: r.subjectRef,
      attestation: r.attestation,
      outcome: r.outcome,
      requestedAt: r.requestedAt,
    }));
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private assertAttested(req: AttestedGdprRequest): void {
    if (req.attestation.trim() === '') {
      // A missing attestation is refused — the trigger must record that a verified
      // request was made (over-trusted-surface guard).
      throw new Error('a GDPR trigger requires a non-empty operator attestation');
    }
    if (req.userId.trim() === '') {
      throw new Error('a GDPR trigger requires a subject user_id');
    }
  }

  /** Append the attestation row (keyed subject_ref — never plaintext user_id). */
  private async audit(req: AttestedGdprRequest, kind: GdprRequestKind, outcome: string): Promise<void> {
    const subjectRef = this.subjectHash.subjectRef(req.gameId, req.userId);
    await this.dataSource.getRepository(GdprRequestAuditEntity).insert({
      gameId: req.gameId,
      operatorId: req.operatorId,
      kind,
      subjectRef,
      attestation: req.attestation.trim(),
      outcome,
      requestedAt: new Date(),
    });
  }
}
