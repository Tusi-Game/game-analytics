/**
 * Upload-status read-model (T-07.24) — the ops dashboard surface, PG-DIRECT and
 * DERIVED at read time (never stored). Per game × day, the status is a function of
 * UPLOAD_BOOKKEEPING row presence ⨝ file-lifecycle state:
 *
 *   n/a           cold storage OFF, or no events that day → no file
 *   open          the day is unsealed (still receiving appends)
 *   pending       sealed, but NO bookkeeping row — includes retrying failures AND
 *                 decode-gate-flagged files (a corrupt file has no verified row)
 *   uploaded      row present, local copy still within retention
 *   local-deleted row present + local_deleted_at set
 *
 * No Redis merge applies (Foundation §3.3's merge rule is for RESULT cells; this
 * is operational metadata). This is the 012-panel read surface.
 *
 * ── ERASURE-REFILTER CONTRACT (T-07.25–27; documented, tool DEFERRED) ─────────
 * Shipped raw objects are NEVER rewritten on the hot path (S3 objects are
 * immutable/PUT-replace; the 01→07 handoff is lock-free). The GDPR posture for a
 * shipped raw object is retention-bounded expiry (`raw_retention_days`, the
 * S3-side sweep in NightlyShipmentService) PLUS a REBUILD-FILTER obligation:
 *
 *   Any tool that REPLAYS a 07-shipped object (the deferred manual rebuild, or any
 *   ad-hoc ops tool that reads a shipped object) MUST re-apply the ERASURE_LEDGER
 *   as a filter step — per replayed envelope, compute the per-game keyed hash of
 *   `user_id` and SKIP the envelope when an `executed` ledger row matches — ALONG
 *   with re-dedup and logical-day flooring. A rebuild that skips the ledger
 *   re-materializes erased data (a GDPR landmine).
 *
 * 008 READS the ERASURE_LEDGER for this contract; it NEVER writes it (gdpr/ owns
 * writes). The optional offline `strict_raw_rewrite` tool (default off) is the ONE
 * sanctioned post-upload object_ref bookkeeping write: filter → write new object →
 * verify → swap object_ref in UPLOAD_BOOKKEEPING → delete old object
 * (replace-not-append, so immutability holds). The rebuild/rewrite TOOLS are
 * deferred; this module pins the contract, not the tool.
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ErasureLedgerEntity } from '../database/entities/erasure-ledger.entity';
import { UploadBookkeepingEntity } from '../database/entities/upload-bookkeeping.entity';
import { checkSealState } from '../common/kernel/seal';
import { ConfigService } from '@nestjs/config';
import { RawFileService } from '../workers/rawfile/raw-file.service';
import { ColdStorageConfigService } from './cold-storage-config.service';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

const MS_PER_MINUTE = 60_000;

/** The five derived statuses of a game × day cold-storage lifecycle. */
export type UploadStatus = 'n/a' | 'open' | 'pending' | 'uploaded' | 'local-deleted';

/** One game × day upload-status row (read-model view). */
export interface UploadStatusRow {
  gameId: string;
  utcDay: string;
  status: UploadStatus;
  /** Present when a row exists (verified in bucket). */
  uploadedAt?: string;
  /** Present when a row exists. */
  objectRef?: string;
  /** Present when the retention pass removed the local copy. */
  localDeletedAt?: string;
  /** Present when a row exists — whether the whole-file decode gate passed. */
  decodeOk?: boolean;
}

@Injectable()
export class UploadStatusReadModel {
  constructor(
    private readonly dataSource: DataSource,
    private readonly rawFiles: RawFileService,
    private readonly coldConfig: ColdStorageConfigService,
    private readonly config: ConfigService,
  ) {}

  private get reportingOffsetMinutes(): number {
    return this.config.get<number>('REPORTING_OFFSET') ?? 0;
  }

  /**
   * Status for one game × day. Combines the durable bookkeeping row with the
   * live file-lifecycle state (does a local file exist? is the day sealed?).
   */
  async statusFor(gameId: string, day: string, now = Date.now()): Promise<UploadStatusRow> {
    const row = await this.dataSource
      .getRepository(UploadBookkeepingEntity)
      .findOne({ where: { gameId, utcDay: day } });

    if (row) {
      const status: UploadStatus = row.localDeletedAt !== null ? 'local-deleted' : 'uploaded';
      return {
        gameId,
        utcDay: day,
        status,
        uploadedAt: row.uploadedAt.toISOString(),
        objectRef: row.objectRef,
        localDeletedAt: row.localDeletedAt !== null ? row.localDeletedAt.toISOString() : undefined,
        decodeOk: row.integrityRef.decode.ok,
      };
    }

    // No row: derive from cold-storage state + the local file + the seal clock.
    const enabled = await this.coldConfig.isEnabled(gameId);
    const fileExists = await this.localFileExists(gameId, day);
    if (!enabled || !fileExists) {
      // Cold off, or no file (no events) → n/a.
      return { gameId, utcDay: day, status: 'n/a' };
    }
    // A file exists with no row: open (unsealed) or pending (sealed, awaiting/retrying/flagged).
    const correctedTime = Date.parse(`${day}T00:00:00Z`) - this.reportingOffsetMinutes * MS_PER_MINUTE + 1;
    const sealed =
      checkSealState({ correctedTime, now, reportingOffsetMinutes: this.reportingOffsetMinutes }) === 'sealed';
    return { gameId, utcDay: day, status: sealed ? 'pending' : 'open' };
  }

  /** All bookkeeping-backed rows for a game (uploaded / local-deleted days). */
  async recordedFor(gameId: string): Promise<UploadStatusRow[]> {
    const rows = await this.dataSource
      .getRepository(UploadBookkeepingEntity)
      .find({ where: { gameId }, order: { utcDay: 'ASC' } });
    return rows.map((row) => ({
      gameId,
      utcDay: row.utcDay,
      status: (row.localDeletedAt !== null ? 'local-deleted' : 'uploaded') as UploadStatus,
      uploadedAt: row.uploadedAt.toISOString(),
      objectRef: row.objectRef,
      localDeletedAt: row.localDeletedAt !== null ? row.localDeletedAt.toISOString() : undefined,
      decodeOk: row.integrityRef.decode.ok,
    }));
  }

  /**
   * The erasure-refilter contract handle (T-07.26): read the executed
   * ERASURE_LEDGER subject-hashes for a game, which any rebuild reading a shipped
   * object MUST use to SKIP erased subjects. 008 READS the ledger, never writes
   * it. Exposed so a future rebuild tool cannot forget the filter (the contract is
   * code, not just prose).
   */
  async erasureFilterHashes(gameId: string): Promise<Set<string>> {
    const rows = await this.dataSource
      .getRepository(ErasureLedgerEntity)
      .find({ where: { gameId, status: 'executed' } });
    return new Set(rows.map((r) => r.subjectRef));
  }

  private async localFileExists(gameId: string, day: string): Promise<boolean> {
    try {
      await fsp.stat(join(this.rawFiles.rootDir, gameId, `${day}.rawlog`));
      return true;
    } catch {
      return false;
    }
  }
}
