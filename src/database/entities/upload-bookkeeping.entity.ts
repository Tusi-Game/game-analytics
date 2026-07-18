import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Integrity reference captured at upload (008 design ER table). A logical ref, not
 * a format spec — carries the seal-time size/checksum used by the verify step and
 * any later audit, plus the whole-file decode-verdict (R6 gate result).
 */
export interface UploadIntegrityRef {
  /** Byte size of the local sealed file at upload time. */
  size: number;
  /** Content checksum (sha256 hex) of the local sealed file at upload time. */
  checksum: string;
  /** Checksum algorithm identifier (forward-compatible; always "sha256" in v1). */
  algo: 'sha256';
  /** Whole-file decode-verdict (R6 gate — 008 owns): did the file decode end-to-end? */
  decode: {
    /** True iff every gzip member decoded (no truncated tail, no interior corruption). */
    ok: boolean;
    /** Number of complete frames decoded. */
    frameCount: number;
    /** True iff the final frame was a truncated tail. */
    truncatedTail: boolean;
    /** Set when the file failed the gate (interior corruption / decode throw). */
    error?: string;
  };
}

/**
 * UPLOAD_BOOKKEEPING — operational metadata about *cold-storage files*, never
 * about events (Foundation §1.2; owner 08; design.md ER table). One row per
 * game × corrected-UTC-day, written **only after a verified upload**.
 *
 * DIRECT-WRITE (Foundation §5 path "direct"): the nightly shipment job writes
 * straight to Postgres — no Redis, no dirty-registry, no flush generation. The
 * row must survive a Redis loss (P7): it is the durable ops truth "did day D
 * ship?".
 *
 * NO status enum: **presence of the row = "object verified in bucket"**; absence
 * = not (yet) shipped; a non-null `localDeletedAt` = the local copy was removed
 * by the retention pass. Rebuild-irrelevant — DB results never depend on it.
 *
 * `gameId` is a LOGICAL FK to GAME (no physical @JoinColumn — mirrors the
 * EXCEPTION_TALLY / ERASURE_LEDGER pattern: the reference set spans specs and the
 * table must build without a hard join). snake_case columns are automatic via
 * SnakeNamingStrategy.
 */
@Entity('upload_bookkeeping')
export class UploadBookkeepingEntity {
  /** Game the file belongs to (logical FK → GAME). */
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  /** Corrected logical day (Foundation §4.7) of the file — the file's seal-day key. */
  @PrimaryColumn({ type: 'date' })
  utcDay!: string;

  /**
   * Verification timestamp — the moment the verified-upload row was recorded.
   * Presence of the row (not a status flag) means "verified in bucket".
   */
  @Column({ type: 'timestamptz' })
  uploadedAt!: Date;

  /** Deterministic per-game×day object reference (one object per game per day). */
  @Column({ type: 'text' })
  objectRef!: string;

  /** Size + checksum + decode-verdict captured at upload (JSONB, logical ref). */
  @Column({ type: 'jsonb' })
  integrityRef!: UploadIntegrityRef;

  /** Nullable; stamped when the retention pass removes the local copy. */
  @Column({ type: 'timestamptz', nullable: true })
  localDeletedAt!: Date | null;
}
