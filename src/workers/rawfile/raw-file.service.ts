/**
 * Write-ahead raw day-file service (bridge 01.5, T-01.32–T-01.39) — the concrete
 * {@link RawAppendPort} that replaces `NoopRawAppendPort`.
 *
 * Responsibilities (002's slice of bridge 01.5):
 *   - Route each append to the per-game × corrected-UTC-day file, among OPEN
 *     files only (T-01.32). Sealed-late verdicts append to the CURRENT open file
 *     with a marker + the offending corrected day.
 *   - Keep ONE dedicated append-writer per open file and group-commit fsyncs
 *     (T-01.33/35) via {@link FileWriter}.
 *   - Frame each batch as a self-contained length-prefixed gzip member (T-01.34)
 *     via {@link encodeFrame}.
 *   - Marker vocabulary = EXCEPTION_TALLY reason names; marker append precedes
 *     the tally increment (the worker increments the tally AFTER this returns).
 *   - Cold-storage-OFF: append is a NO-OP (no file, no fsync, no lifecycle) but
 *     still mints the ordering token so counters run unchanged (T-01.38).
 *   - Provide the decode-check HOOK (007 owns the whole-file gate, R6).
 *
 * NOT owned here: seal→upload→verify→delete lifecycle + bookkeeping (008), the
 * whole-file decode-verify gate (007). This service only ever writes OPEN files.
 */

import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EventEnvelope } from '../../common/contracts/envelope';
import type { RawAppendedToken, RawAppendIntent, RawAppendPort } from '../kernel/pipeline-steps';
import { FileWriter, type GroupCommitOptions } from './file-writer';
import {
  decodeFrames,
  encodeFrame,
  type DecodeResult,
  type RawAppendPayload,
  type RawFileCodec,
  type RawRecordEntry,
} from './framing';

/** DI token for group-commit tuning (tests inject a widened/zeroed window). */
export const RAW_FILE_OPTIONS = 'RAW_FILE_OPTIONS';

/** Resolved runtime options for the raw-file writer. */
export interface RawFileServiceOptions extends GroupCommitOptions {
  /** Root directory for raw day-files. Defaults to env `RAW_FILE_DIR` or `./raw`. */
  dir?: string;
  /** Whether cold storage is enabled. `false` ⇒ step 4 is a no-op. Default true. */
  coldStorageEnabled?: boolean;
  /** File codec (forward-only). Default gzip. */
  codec?: RawFileCodec;
}

@Injectable()
export class RawFileService implements RawAppendPort, OnModuleDestroy {
  private readonly logger = new Logger(RawFileService.name);
  private readonly dir: string;
  private readonly coldStorageEnabled: boolean;
  private readonly codec: RawFileCodec;
  private readonly coalesceMs: number;
  /** Open append-writers keyed by absolute file path (one per open game×day). */
  private readonly writers = new Map<string, FileWriter>();

  constructor(
    private readonly config: ConfigService,
    @Inject(RAW_FILE_OPTIONS) options: RawFileServiceOptions = {},
  ) {
    this.dir = options.dir ?? this.config.get<string>('RAW_FILE_DIR') ?? join(process.cwd(), 'raw');
    this.coldStorageEnabled = options.coldStorageEnabled ?? true;
    this.codec = options.codec ?? 'gzip';
    this.coalesceMs = options.coalesceMs ?? 0;
  }

  /**
   * Step 4 — write-ahead raw append. Appends the FULL envelope (body or
   * quarantine-marked), fsync'd BEFORE this resolves, so the caller's counter can
   * never precede durability. `skip-drop` never touches the file (drops are never
   * appended). Cold-storage-off makes every intent a no-op.
   */
  async append(
    envelope: EventEnvelope,
    correctedDay: string,
    intent: RawAppendIntent,
    batchJobId: string,
  ): Promise<{ token: RawAppendedToken; appended: boolean }> {
    // Drops are NEVER raw-appended (bridge 01.5 §3).
    if (intent === 'skip-drop') {
      return { token: mintToken(), appended: false };
    }

    // Cold-storage-off (T-01.38): step 4 is a pure no-op — no file, no fsync, no
    // lifecycle — but the token is still minted so counters/tallies run unchanged
    // (SC-008 superset waived, operator-accepted). Do NOT diverge branches beyond
    // this: the on-path below differs only by the fsync it performs.
    if (!this.coldStorageEnabled) {
      return { token: mintToken(), appended: false };
    }

    const entry: RawRecordEntry = {
      cls: intent === 'append-quarantine' ? 'quarantine' : 'body',
      envelope,
      v: effectiveVersion(envelope),
      corrected_day: correctedDay,
    };
    const payload: RawAppendPayload = { job_id: batchJobId, records: [entry] };

    const filePath = this.filePathFor(envelope.game_id, correctedDay);
    const writer = await this.writerFor(filePath);
    const frame = encodeFrame(payload, this.codec);

    // Resolves only after this frame's fsync completes (group-committed).
    await writer.append(frame);
    return { token: mintToken(), appended: true };
  }

  /**
   * Batch variant — append a whole dequeued batch's records in ONE frame + ONE
   * fsync. The worker uses this when a batch's records all route to the same
   * (game × day) file so the fsync grain is one-per-batch (bridge 01.5 §4). Every
   * caller's await still blocks on the same fsync. Returns once durable.
   */
  async appendBatch(
    gameId: string,
    correctedDay: string,
    records: RawRecordEntry[],
    batchJobId: string,
  ): Promise<void> {
    if (!this.coldStorageEnabled || records.length === 0) {
      return;
    }
    const filePath = this.filePathFor(gameId, correctedDay);
    const writer = await this.writerFor(filePath);
    const frame = encodeFrame({ job_id: batchJobId, records }, this.codec);
    await writer.append(frame);
  }

  /**
   * The absolute path for a game's corrected-day file: `{dir}/{game_id}/{day}.rawlog`.
   * Routing is by CORRECTED day (bridge 01.5 §2), never arrival day. The `game_id`
   * is a trusted server-derived value (never raw body input) so it is a safe path
   * segment; we still reject separators defensively.
   */
  filePathFor(gameId: string, correctedDay: string): string {
    if (gameId.includes('/') || gameId.includes('..') || correctedDay.includes('/') || correctedDay.includes('..')) {
      throw new Error(`[rawfile] illegal path segment for game "${gameId}" day "${correctedDay}"`);
    }
    return join(this.dir, gameId, `${correctedDay}.rawlog`);
  }

  /** Get-or-create the dedicated append-writer for an open file. */
  private async writerFor(filePath: string): Promise<FileWriter> {
    let writer = this.writers.get(filePath);
    if (!writer) {
      await fsp.mkdir(dirname(filePath), { recursive: true });
      writer = new FileWriter(filePath, { coalesceMs: this.coalesceMs });
      this.writers.set(filePath, writer);
    }
    return writer;
  }

  /**
   * Rotation by seal only (T-01.37): close the writer for a now-sealed
   * (game × day) file. After close the file is COMPLETE/immutable and
   * upload-eligible — 008 ships it, this service never reopens it. No intra-day
   * rotation. The worker's seal-time flush calls this for the sealed day.
   */
  async sealFile(gameId: string, correctedDay: string): Promise<void> {
    const filePath = this.filePathFor(gameId, correctedDay);
    const writer = this.writers.get(filePath);
    if (writer) {
      await writer.close();
      this.writers.delete(filePath);
    }
  }

  /**
   * Seal-time decode-check HOOK (T-01.39, R6): read a sealed file back and verify
   * every gzip member decodes end-to-end. This is only the HOOK — 007 owns the
   * whole-file GATE that decides upload-eligibility and records `integrity_ref`.
   * Returns the decode result (007 acts on `truncatedTail`).
   */
  async decodeCheck(gameId: string, correctedDay: string): Promise<DecodeResult> {
    const filePath = this.filePathFor(gameId, correctedDay);
    const buffer = await fsp.readFile(filePath);
    return decodeFrames(buffer);
  }

  /** Flush + close every open writer on shutdown so no queued append is lost. */
  async onModuleDestroy(): Promise<void> {
    const closes = [...this.writers.values()].map((w) =>
      w.close().catch((err) => this.logger.error(`[rawfile] close failed: ${String(err)}`)),
    );
    this.writers.clear();
    await Promise.all(closes);
  }

  /** Root directory (tests / observability). */
  get rootDir(): string {
    return this.dir;
  }

  /** Whether cold storage is enabled (tests). */
  get isColdStorageEnabled(): boolean {
    return this.coldStorageEnabled;
  }
}

/** Mint the branded proof-of-append token (Unit 2 makes fsync-before-count compile-enforced). */
function mintToken(): RawAppendedToken {
  return {} as RawAppendedToken;
}

/** Effective wire version: absent ⇒ 1 (§1.1). */
function effectiveVersion(envelope: EventEnvelope): number {
  const v = (envelope as unknown as { v?: unknown }).v;
  return typeof v === 'number' && Number.isFinite(v) ? v : 1;
}
