/**
 * Nightly shipment — flow (b) of 008 (T-07.9–07.19, T-07.29–07.34).
 *
 * The once-a-day cost-control flow, independent of the per-event write-ahead
 * append (which 002 owns). Per game, per file, with per-file isolation (one
 * failure never blocks the rest):
 *
 *   0. SEAL-DRIVE (008 is the seal-driver — the manager's settled decision): for
 *      every local day whose seal state is `sealed`, call RawFileService.sealFile
 *      to drain+close the still-open writer, making the file COMPLETE/immutable.
 *      (RawFileService.sealFile / decodeCheck are otherwise dead code — nothing
 *      else calls them at runtime.)
 *   1. ENUMERATE: local sealed day-files with NO UPLOAD_BOOKKEEPING row
 *      (state-derived ⇒ catch-up safe; a missed run picks up every sealed-unshipped
 *      day, not just yesterday's).
 *   2a. DECODE-VERIFY GATE (R6 — 008 owns the WHOLE-FILE gate via decodeCheck):
 *      a file that fails full multi-member decode (truncated tail OR interior
 *      throw) is FLAGGED in integrity_ref and NOT shipped — never a valid rebuild
 *      floor.
 *   2b. UPLOAD: idempotent PUT to the deterministic object_ref.
 *   3. VERIFY: read-back size/checksum vs the local file BEFORE recording.
 *   4. RECORD: insert the UPLOAD_BOOKKEEPING row only AFTER verify
 *      (verify-then-record — "an upload does not exist until the row does").
 *   5. DELETE-LOCAL: iff now ≥ uploaded_at + local_retention_days AND a verified
 *      row exists; stamp local_deleted_at. NEVER delete without a verified row —
 *      the delete step reads the ROW, not a job-local flag (P2).
 *
 * Order = decode-gate ≺ upload ≺ verify ≺ record ≺ delete (the whole safety
 * chain). No Redis job-lock: eligibility is state-derived and every step is
 * overwrite-idempotent, so an overlapping run is harmless (a Redis lock would
 * violate the accepted-loss posture, P7).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { checkSealState } from '../common/kernel/seal';
import { RawFileService } from '../workers/rawfile/raw-file.service';
import { UploadBookkeepingEntity, type UploadIntegrityRef } from '../database/entities/upload-bookkeeping.entity';
import { ColdStorageConfigService } from './cold-storage-config.service';
import { S3ClientService } from './s3-client.service';
import { objectRefFor, checksumOf, RAW_OBJECT_PREFIX } from './object-ref';

/** One local day-file candidate discovered on disk. */
interface LocalDayFile {
  gameId: string;
  day: string;
  path: string;
}

/** Per-run summary (returned for observability + tests). */
export interface ShipmentSummary {
  /** Games whose files were considered. */
  games: number;
  /** Files sealed (writer drained + closed) this run. */
  sealed: number;
  /** Files shipped (uploaded + verified + row recorded). */
  shipped: number;
  /** Files flagged as corrupt by the decode-gate (NOT shipped). */
  flagged: number;
  /** Files deleted locally by the retention pass. */
  deleted: number;
  /** Files that failed upload/verify (no row written; will retry next run). */
  failed: number;
  /** Objects expired from S3 by the raw-retention sweep. */
  expired: number;
}

const MS_PER_DAY = 24 * 60 * 60_000;
const MS_PER_MINUTE = 60_000;

/**
 * Map a corrected LOGICAL-day string (`YYYY-MM-DD`) to a representative UTC
 * epoch-ms strictly inside that logical day, so {@link checkSealState} computes
 * D_end + grace for exactly that day. The day string is the offset-local calendar
 * day; its UTC start is `parse(D)−offset`. +1 ms lands strictly inside D.
 */
function logicalDayInstant(day: string, reportingOffsetMinutes: number): number {
  return Date.parse(`${day}T00:00:00Z`) - reportingOffsetMinutes * MS_PER_MINUTE + 1;
}

@Injectable()
export class NightlyShipmentService {
  private readonly logger = new Logger(NightlyShipmentService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly rawFiles: RawFileService,
    private readonly coldConfig: ColdStorageConfigService,
    private readonly s3: S3ClientService,
    private readonly config: ConfigService,
  ) {}

  /** Platform reporting offset (minutes) — same clock the seal boundary uses. */
  private get reportingOffsetMinutes(): number {
    return this.config.get<number>('REPORTING_OFFSET') ?? 0;
  }

  /**
   * Run one shipment pass. `now` is injectable for deterministic tests.
   * Per-game and per-file isolation: every await is wrapped so one failure only
   * fails that file/game and the run continues.
   */
  async run(now = Date.now()): Promise<ShipmentSummary> {
    const summary: ShipmentSummary = { games: 0, sealed: 0, shipped: 0, flagged: 0, deleted: 0, failed: 0, expired: 0 };
    const byGame = await this.discoverLocalFiles();
    summary.games = byGame.size;

    for (const [gameId, files] of byGame) {
      try {
        await this.runGame(gameId, files, now, summary);
      } catch (err) {
        this.logger.error(`[cold-storage] game ${gameId} run failed (isolated): ${String(err)}`);
      }
    }
    return summary;
  }

  /** Process every sealed file for one game, then run its retention passes. */
  private async runGame(gameId: string, files: LocalDayFile[], now: number, summary: ShipmentSummary): Promise<void> {
    const cfg = await this.coldConfig.forGame(gameId);

    // Cold-off: the whole lifecycle is a no-op for this game (T-07.22). Files that
    // were written while it was on still complete their lifecycle if a row exists,
    // but with cold storage off we do not seal/ship new ones.
    if (!cfg.enabled) {
      return;
    }

    // 0. SEAL-DRIVE + 1. ENUMERATE (state-derived, catch-up safe).
    const sealedFiles: LocalDayFile[] = [];
    for (const file of files) {
      if (!this.isSealed(file.day, now)) {
        continue; // still open / in grace — not upload-eligible.
      }
      try {
        // Drain + close the open writer for this now-sealed day (008 is the
        // seal-driver). Idempotent: sealFile is a no-op if no writer is open.
        await this.rawFiles.sealFile(gameId, file.day);
        summary.sealed += 1;
      } catch (err) {
        this.logger.error(`[cold-storage] seal ${gameId}/${file.day} failed (isolated): ${String(err)}`);
        summary.failed += 1;
        continue;
      }
      sealedFiles.push(file);
    }

    // Skip already-shipped days (row present ⇒ enumerate no-op, T-07.18).
    const repo = this.dataSource.getRepository(UploadBookkeepingEntity);
    for (const file of sealedFiles) {
      const existing = await repo.findOne({ where: { gameId, utcDay: file.day } });
      if (existing) {
        continue; // already verified in bucket — skip.
      }
      await this.shipFile(gameId, file, cfg, now, summary);
    }

    // 5. RETENTION PASS (delete-local) — over VERIFIED rows only (reads the row,
    // never a job-local flag, P2).
    await this.retentionPass(gameId, cfg, now, summary);

    // S3-side raw expiry (T-07.23) — scoped to the raw prefix, never PITR bucket.
    await this.expireRaw(gameId, cfg, now, summary);
  }

  /**
   * Ship one file through the full safety chain. Per-file isolation: any failure
   * is caught here so the caller's loop continues; on any failure NO row is
   * written, so the file survives for the next run (idempotent re-ship).
   */
  private async shipFile(
    gameId: string,
    file: LocalDayFile,
    cfg: Awaited<ReturnType<ColdStorageConfigService['forGame']>>,
    now: number,
    summary: ShipmentSummary,
  ): Promise<void> {
    try {
      const body = await fsp.readFile(file.path);
      const size = body.length;
      const checksum = checksumOf(body);

      // 2a. DECODE-VERIFY GATE (R6, whole-file). truncated tail OR interior throw
      // ⇒ flag in integrity_ref and DO NOT ship (never a valid rebuild floor).
      const gate = await this.decodeGate(gameId, file.day);
      if (!gate.ok) {
        // Flagged for operator attention: NOT shipped, NOT deleted. We do not
        // record a bookkeeping row (row = verified-in-bucket). Just log the
        // verdict; the file stays local as `pending` in the read-model.
        this.logger.warn(
          `[cold-storage] decode-gate REJECT ${gameId}/${file.day}: ${gate.error ?? 'truncated/corrupt'} — not shipped`,
        );
        summary.flagged += 1;
        return;
      }

      const target = this.s3.resolveTarget(cfg.credentialsCipher, cfg.bucket);
      const objectRef = objectRefFor(gameId, file.day);

      // 2b. UPLOAD (idempotent PUT-replace at the deterministic ref).
      await this.s3.put(target, objectRef, body);

      // 3. VERIFY read-back BEFORE recording.
      const verify = await this.s3.verify(target, objectRef, size, checksum);
      if (!verify.ok) {
        this.logger.warn(`[cold-storage] verify FAILED ${gameId}/${file.day} — no row, file survives`);
        summary.failed += 1;
        return;
      }

      // 4. RECORD (verify-then-record). Presence of the row = verified-in-bucket.
      const integrityRef: UploadIntegrityRef = {
        size,
        checksum,
        algo: 'sha256',
        decode: { ok: true, frameCount: gate.frameCount, truncatedTail: false },
      };
      await this.dataSource.getRepository(UploadBookkeepingEntity).save({
        gameId,
        utcDay: file.day,
        // Stamp with the run clock so the retention window compares on one clock
        // (injectable `now` in tests; wall-clock in production).
        uploadedAt: new Date(now),
        objectRef,
        integrityRef,
        localDeletedAt: null,
      });
      summary.shipped += 1;
    } catch (err) {
      // Crash/error mid-upload/verify: no row written ⇒ next run re-ships from
      // scratch to the SAME ref (overwrite-idempotent). File survives.
      this.logger.error(`[cold-storage] ship ${gameId}/${file.day} failed (isolated): ${String(err)}`);
      summary.failed += 1;
    }
  }

  /**
   * Whole-file decode-verify gate (R6). Consumes 002's decodeCheck HOOK and turns
   * its verdict into the gate: `ok=false` when the tail is truncated OR decodeCheck
   * throws (interior corruption). 008 OWNS this gate; 002 only provides the hook.
   */
  private async decodeGate(gameId: string, day: string): Promise<{ ok: boolean; frameCount: number; error?: string }> {
    try {
      const result = await this.rawFiles.decodeCheck(gameId, day);
      if (result.truncatedTail) {
        return { ok: false, frameCount: result.frameCount, error: 'truncated tail' };
      }
      return { ok: true, frameCount: result.frameCount };
    } catch (err) {
      // Interior corruption / bad magic / interior gzip failure — hard reject.
      return { ok: false, frameCount: 0, error: String(err) };
    }
  }

  /**
   * Delete-local for verified rows whose retention window has elapsed
   * (`now ≥ uploaded_at + local_retention_days`). Reads the ROW (P2), stamps
   * local_deleted_at. Never touches a file without a verified row.
   */
  private async retentionPass(
    gameId: string,
    cfg: Awaited<ReturnType<ColdStorageConfigService['forGame']>>,
    now: number,
    summary: ShipmentSummary,
  ): Promise<void> {
    const repo = this.dataSource.getRepository(UploadBookkeepingEntity);
    const rows = await repo.find({ where: { gameId } });
    for (const row of rows) {
      if (row.localDeletedAt !== null) {
        continue; // already removed.
      }
      const dueAt = row.uploadedAt.getTime() + cfg.localRetentionDays * MS_PER_DAY;
      if (now < dueAt) {
        continue; // still within retention window — defer.
      }
      const path = this.rawFiles.filePathFor(gameId, row.utcDay);
      try {
        await fsp.rm(path, { force: true });
        row.localDeletedAt = new Date(now);
        await repo.save(row);
        summary.deleted += 1;
      } catch (err) {
        this.logger.error(`[cold-storage] delete-local ${gameId}/${row.utcDay} failed (isolated): ${String(err)}`);
      }
    }
  }

  /**
   * S3-side raw expiry (T-07.23): remove shipped objects older than
   * `raw_retention_days`. Scoped to the raw prefix — NEVER the PITR backup bucket
   * (which is a different bucket entirely, T-07.28). 0 = disabled (keep forever).
   */
  private async expireRaw(
    gameId: string,
    cfg: Awaited<ReturnType<ColdStorageConfigService['forGame']>>,
    now: number,
    summary: ShipmentSummary,
  ): Promise<void> {
    if (cfg.rawRetentionDays <= 0) {
      return;
    }
    try {
      const target = this.s3.resolveTarget(cfg.credentialsCipher, cfg.bucket);
      const cutoff = new Date(now - cfg.rawRetentionDays * MS_PER_DAY);
      // Scope to this game's raw prefix so we never enumerate PITR objects even if
      // they shared a bucket (they must not — separate bucket — but scoping is
      // belt-and-braces per T-07.28).
      const deleted = await this.s3.expireOlderThan(target, `${RAW_OBJECT_PREFIX}${gameId}/`, cutoff);
      summary.expired += deleted.length;
    } catch (err) {
      this.logger.error(`[cold-storage] raw-expiry ${gameId} failed (isolated): ${String(err)}`);
    }
  }

  /** Is `day`'s logical day sealed as of `now` (D_end + 48h grace)? */
  private isSealed(day: string, now: number): boolean {
    // The file key is the corrected LOGICAL day; use a representative instant
    // inside it so checkSealState computes D_end + grace for exactly that day.
    const correctedTime = logicalDayInstant(day, this.reportingOffsetMinutes);
    return checkSealState({ correctedTime, now, reportingOffsetMinutes: this.reportingOffsetMinutes }) === 'sealed';
  }

  /**
   * Discover local raw day-files under the raw root: `{rootDir}/{gameId}/{day}.rawlog`.
   * Missing root ⇒ empty (nothing written yet). Grouped by game.
   */
  private async discoverLocalFiles(): Promise<Map<string, LocalDayFile[]>> {
    const root = this.rawFiles.rootDir;
    const byGame = new Map<string, LocalDayFile[]>();
    let gameDirs: string[];
    try {
      gameDirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return byGame; // no raw dir yet.
    }
    for (const gameId of gameDirs) {
      const gameDir = join(root, gameId);
      let entries: string[];
      try {
        entries = (await fsp.readdir(gameDir, { withFileTypes: true }))
          .filter((e) => e.isFile() && e.name.endsWith('.rawlog'))
          .map((e) => e.name);
      } catch {
        continue;
      }
      const files: LocalDayFile[] = entries.map((name) => ({
        gameId,
        day: name.slice(0, -'.rawlog'.length),
        path: join(gameDir, name),
      }));
      if (files.length > 0) {
        byGame.set(gameId, files);
      }
    }
    return byGame;
  }
}
