/**
 * Single dedicated append-writer per open raw file, with GROUP COMMIT
 * (bridge 01.5 §4, T-01.33/T-01.35, OF-5).
 *
 * THE SC-008 GUARANTEE, mechanically:
 *   - One writer per open file serializes appends → no interleaved / torn gzip
 *     members from concurrent workers (one file, one writer).
 *   - Group commit: many workers' `append()` calls that arrive within one
 *     coalesce tick are written back-to-back and made durable by ONE `fsync`.
 *   - A caller's `append()` promise resolves ONLY AFTER the fsync that covers ITS
 *     bytes has completed. So a worker's step-8 counter write — which `await`s
 *     `append()` — provably blocks on fsync-before-count for its own batch, not
 *     merely on enqueue-to-writer (DARK-SPOT #3). A hot single game therefore
 *     does not collapse worker concurrency to one (many appends, one fsync), yet
 *     no counter ever runs ahead of its own durable bytes.
 *
 * Failure direction (bridge 01.5 §10): a crash between fsync and the counter
 * leaves a logged-but-uncounted event (safe undercount). A crash before fsync
 * completes rejects the pending `append()`s, so the counter never runs → the
 * event is neither logged nor counted (also safe). "Counted-but-unlogged" is
 * impossible because the counter is downstream of the resolved fsync.
 */

import { promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

/** A queued append awaiting the next group-commit fsync. */
interface PendingAppend {
  frame: Buffer;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** Tuning for the group-commit coalesce window. */
export interface GroupCommitOptions {
  /**
   * Coalesce delay in ms before a batch of pending appends is flushed+fsync'd.
   * `0` = coalesce only within the current event-loop turn (flush on next tick);
   * a small positive value widens the window to batch across ticks. Default 0.
   */
  coalesceMs?: number;
}

/**
 * Owns one append-only file handle and serializes all writes to it. Constructed
 * by the {@link RawFileWriter} registry once per open (game × day) file; never
 * shared across files.
 */
export class FileWriter {
  private handle: FileHandle | null = null;
  private opening: Promise<FileHandle> | null = null;
  private readonly pending: PendingAppend[] = [];
  private flushScheduled = false;
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly coalesceMs: number;

  constructor(
    private readonly filePath: string,
    options: GroupCommitOptions = {},
  ) {
    this.coalesceMs = options.coalesceMs ?? 0;
  }

  /**
   * Append one framed buffer. Resolves ONLY after the buffer is written AND
   * fsync'd (group-committed with any sibling appends in the same window). The
   * caller (the raw-append port) must `await` this before any counter write.
   */
  append(frame: Buffer): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error(`[rawfile] append after close for ${this.filePath}`));
    }
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ frame, resolve, reject });
      this.scheduleFlush();
    });
  }

  /** Lazily open the append handle (created on first append). */
  private async ensureHandle(): Promise<FileHandle> {
    if (this.handle) {
      return this.handle;
    }
    if (!this.opening) {
      // 'a' → append mode, create if absent. One handle for the file's life.
      this.opening = fsp.open(this.filePath, 'a').then((h) => {
        this.handle = h;
        return h;
      });
    }
    return this.opening;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    const kick = (): void => {
      this.flushScheduled = false;
      // Chain flushes so two windows never overlap on the one handle.
      this.flushing = this.flushing.then(() => this.flushOnce());
    };
    if (this.coalesceMs > 0) {
      setTimeout(kick, this.coalesceMs);
    } else {
      // Defer to the next macrotask so all appends queued in this turn coalesce.
      setImmediate(kick);
    }
  }

  /**
   * Flush every currently-pending append in ONE write + ONE fsync, then resolve
   * exactly those appends. Appends queued after this snapshot wait for the next
   * window. On any I/O error every append in this window is rejected (so its
   * counter never runs).
   */
  private async flushOnce(): Promise<void> {
    const batch = this.pending.splice(0, this.pending.length);
    if (batch.length === 0) {
      return;
    }
    try {
      const handle = await this.ensureHandle();
      // One coalesced write of all frames in insertion order (serialized).
      const combined = Buffer.concat(batch.map((p) => p.frame));
      await handle.write(combined);
      // ONE fsync makes this whole window durable (group commit).
      await handle.sync();
      for (const p of batch) {
        p.resolve();
      }
    } catch (err) {
      for (const p of batch) {
        p.reject(err);
      }
    }
  }

  /**
   * Flush any queued appends and close the handle (called at seal / rotation /
   * shutdown). After close, `append()` rejects.
   */
  async close(): Promise<void> {
    this.closed = true;
    // Drain: run one final flush window for anything still queued, then await
    // the whole flush chain so no write is lost.
    if (this.pending.length > 0) {
      this.flushing = this.flushing.then(() => this.flushOnce());
    }
    await this.flushing;
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }

  /** The path this writer owns (observability / tests). */
  get path(): string {
    return this.filePath;
  }
}
