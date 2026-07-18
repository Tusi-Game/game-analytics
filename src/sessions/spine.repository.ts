/**
 * USER_SPINE durable-immediate primitives (P7, bridge 02.5 sequences A + B).
 *
 * Both operations go STRAIGHT to Postgres in step 7, BEFORE any Redis write, and
 * are NEVER flush-mediated. They are the platform's one cross-story durable-write
 * delegation — [003-sessions] executes them on [005-retention]'s behalf.
 *
 *   7a  {@link seedFirstSeen}  — INSERT … ON CONFLICT (game_id,user_id) DO NOTHING
 *       RETURNING first_seen. Row present ⇒ THIS event created the spine row
 *       (handles the concurrent-seed race: exactly one INSERT wins, the loser sees
 *       no returned row and reads the winner's first_seen). Write-once; never
 *       back-dated. The bitmap is seeded all-zero at the fixed span so `set_bit`
 *       never hits an out-of-range offset within the span.
 *
 *   7b′ {@link setActivityBit} — one atomic conditional UPDATE using set_bit()
 *       guarded by get_bit()=0, RETURNING 1. The RETURNING row's PRESENCE IS the
 *       0→1 transition report (Postgres reports 0 affected rows when the bit was
 *       already set ⇒ full no-op ⇒ 8b skipped). Offsets ≥ the span are guarded in
 *       the caller (over-horizon silent no-op) so this SQL never sees one.
 *
 * BIGINT / bit-string columns are handled as strings; the repo returns typed
 * results (no `any`). `first_seen` round-trips as a `Date`.
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** Result of the 7a insert-if-absent seed. */
export interface SeedFirstSeenResult {
  /** True iff THIS call created the spine row (RETURNING row present). */
  created: boolean;
  /** The authoritative `first_seen` (this event's value if created, else the durable one). */
  firstSeen: Date;
}

@Injectable()
export class SpineRepository {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * 7a — insert-if-absent `(game_id, user_id, first_seen, all-zero bitmap)`.
   * @param bitmapSpan number of bits to seed the new row's bitmap with (fixed span).
   * @returns `{ created, firstSeen }` — `created` when the RETURNING row is present.
   */
  async seedFirstSeen(
    gameId: string,
    userId: string,
    firstSeen: Date,
    bitmapSpan: number,
  ): Promise<SeedFirstSeenResult> {
    // repeat('0', span)::bit(span)::bit varying — a fixed-width all-zero bitmap.
    // The INSERT wins-or-noops atomically; the RETURNING row proves creation.
    const inserted: Array<{ first_seen: Date }> = await this.dataSource.query(
      `INSERT INTO user_spine (game_id, user_id, first_seen, active_days_bitmap)
       VALUES ($1, $2, $3, repeat('0', $4)::bit varying)
       ON CONFLICT (game_id, user_id) DO NOTHING
       RETURNING first_seen`,
      [gameId, userId, firstSeen.toISOString(), bitmapSpan],
    );
    if (inserted.length > 0 && inserted[0] !== undefined) {
      return { created: true, firstSeen: coerceDate(inserted[0].first_seen) };
    }
    // Lost the race (or row pre-existed) — read the durable first_seen.
    const existing: Array<{ first_seen: Date }> = await this.dataSource.query(
      `SELECT first_seen FROM user_spine WHERE game_id = $1 AND user_id = $2`,
      [gameId, userId],
    );
    if (existing.length === 0 || existing[0] === undefined) {
      // Should be impossible (DO NOTHING means a row exists), but fail loud rather
      // than silently mis-report a non-existent spine row.
      throw new Error(`[spine] seedFirstSeen: no row after ON CONFLICT DO NOTHING for (${gameId}, ${userId})`);
    }
    return { created: false, firstSeen: coerceDate(existing[0].first_seen) };
  }

  /**
   * 7b′ — set-once activity bit. Atomic conditional UPDATE: set bit `offset` to 1
   * iff it is currently 0, RETURNING 1. Returns true on a reported 0→1 transition
   * (row affected), false on a full no-op (bit already set).
   *
   * The caller MUST have already guarded `0 ≤ offset < bitmapSpan` (negative and
   * over-horizon offsets never reach here) so `set_bit`/`get_bit` are always in
   * range.
   *
   * NOTE: TypeORM's `query()` returns a `[affectedRows[], affectedCount]` TUPLE for
   * `UPDATE … RETURNING` (unlike INSERT/SELECT which return a plain rows array), so
   * we read the affected count via {@link affectedCount} — using the whole result's
   * `.length` would ALWAYS be 2 and wrongly report a transition every time.
   */
  async setActivityBit(gameId: string, userId: string, offset: number): Promise<boolean> {
    const result: unknown = await this.dataSource.query(
      `UPDATE user_spine
         SET active_days_bitmap = set_bit(active_days_bitmap, $3, 1)
       WHERE game_id = $1 AND user_id = $2 AND get_bit(active_days_bitmap, $3) = 0
       RETURNING 1`,
      [gameId, userId, offset],
    );
    return affectedCount(result) > 0;
  }

  /** Read a spine row's first_seen (used by the read model / spine re-scan). */
  async findFirstSeen(gameId: string, userId: string): Promise<Date | null> {
    const rows: Array<{ first_seen: Date }> = await this.dataSource.query(
      `SELECT first_seen FROM user_spine WHERE game_id = $1 AND user_id = $2`,
      [gameId, userId],
    );
    return rows.length > 0 && rows[0] !== undefined ? coerceDate(rows[0].first_seen) : null;
  }
}

/** Coerce a driver value (Date or ISO string) to a Date. */
function coerceDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * The number of rows affected by an `UPDATE … RETURNING` run through TypeORM's
 * `query()`. TypeORM returns a `[affectedRows[], affectedCount]` tuple for such
 * statements; this reads the count robustly whether the driver returns the tuple
 * or (defensively) a plain rows array.
 */
function affectedCount(result: unknown): number {
  if (Array.isArray(result)) {
    // Tuple form `[rows[], count]` — the second element is the affected count.
    if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
      return result[1];
    }
    // Plain rows array fallback.
    return result.length;
  }
  return 0;
}
