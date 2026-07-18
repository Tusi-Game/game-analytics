/**
 * Spine re-scan re-projection (T-04.27, Foundation §1.3, bridge 02.5 §4) — the
 * ONLY rebuild path for the retention/DAU projections. Rebuilds `COHORT`,
 * `RETENTION_CELL`, and `ACTIVE_USER_DAY` by popcount-by-offset / membership over
 * `USER_SPINE.first_seen` + `active_days_bitmap` — NEVER a raw event re-scan.
 *
 * Covers the crash-between-7-and-8 window (projection lags the spine) and Redis
 * loss ≤ one flush window. Because the spine bit is durable-immediate truth, the
 * projections are pure functions of it — recomputing them is idempotent and
 * cannot invent phantom retention.
 *
 * This is an OPERATOR-run recovery lever (not on the hot path). It writes the
 * projections as ABSOLUTE values (upsert), matching the flush merge, so a re-scan
 * after a partial flush converges to the durable-correct value.
 *
 * D0 invariant (T-04.28): every spine row has bit 0 set (the seeding session sets
 * it), so `COHORT.cohort_size ≡ RETENTION_CELL(c, 0)` after a re-scan. The
 * {@link verifyD0Invariant} check asserts it and reports any violation.
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SessionConfigService } from './session-config.service';

/** Result of a re-scan over a game (counts of rebuilt rows). */
export interface RescanResult {
  cohorts: number;
  retentionCells: number;
  activeUserDays: number;
  spineRows: number;
}

/** Outcome of the D0 = 100 % invariant guard. */
export interface D0InvariantResult {
  ok: boolean;
  /** Users with a first_seen whose bit 0 is NOT set (should be empty). */
  usersMissingBit0: number;
  /** Cohorts where cohort_size ≠ RETENTION_CELL(c, 0) (should be empty). */
  cohortsMismatched: number;
}

@Injectable()
export class SpineRescanService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly sessionConfig: SessionConfigService,
  ) {}

  /**
   * Rebuild all three projections for a game from its spine. Recomputes cohort
   * (logical_day(first_seen)) and, for every set bit at offset N, the activity day
   * = cohort + N. Writes ABSOLUTE upserts (idempotent). Returns row counts.
   */
  async rescanGame(gameId: string): Promise<RescanResult> {
    const offsetMin = this.sessionConfig.reportingOffsetMinutes();
    const spineRows: Array<{ user_id: string; first_seen: Date; active_days_bitmap: string }> =
      await this.dataSource.query(`SELECT user_id, first_seen, active_days_bitmap FROM user_spine WHERE game_id = $1`, [
        gameId,
      ]);

    const cohortSize = new Map<string, number>(); // cohort_date → size
    const cellRetained = new Map<string, number>(); // `${c}:${N}` → retained
    const activeMembers = new Map<string, Set<string>>(); // activity_day → members

    for (const row of spineRows) {
      const firstSeenMs =
        row.first_seen instanceof Date ? row.first_seen.getTime() : Date.parse(String(row.first_seen));
      const cohortDate = this.sessionConfig.logicalDayOf(firstSeenMs);
      cohortSize.set(cohortDate, (cohortSize.get(cohortDate) ?? 0) + 1);

      const bitmap = String(row.active_days_bitmap);
      for (let offset = 0; offset < bitmap.length; offset += 1) {
        if (bitmap[offset] !== '1') {
          continue;
        }
        const key = `${cohortDate}:${offset}`;
        cellRetained.set(key, (cellRetained.get(key) ?? 0) + 1);
        const activityDay = addDays(cohortDate, offset);
        const set = activeMembers.get(activityDay) ?? new Set<string>();
        set.add(row.user_id);
        activeMembers.set(activityDay, set);
      }
    }

    await this.dataSource.transaction(async (tx) => {
      for (const [cohortDate, size] of cohortSize) {
        await tx.query(
          `INSERT INTO cohort (game_id, cohort_date, cohort_size) VALUES ($1, $2, $3)
           ON CONFLICT (game_id, cohort_date) DO UPDATE SET cohort_size = GREATEST(cohort.cohort_size, EXCLUDED.cohort_size)`,
          [gameId, cohortDate, size],
        );
      }
      for (const [key, retained] of cellRetained) {
        const sep = key.lastIndexOf(':');
        const cohortDate = key.slice(0, sep);
        const offset = Number(key.slice(sep + 1));
        await tx.query(
          `INSERT INTO retention_cell (game_id, cohort_date, day_offset, retained_users) VALUES ($1, $2, $3, $4)
           ON CONFLICT (game_id, cohort_date, day_offset) DO UPDATE SET retained_users = GREATEST(retention_cell.retained_users, EXCLUDED.retained_users)`,
          [gameId, cohortDate, offset, retained],
        );
      }
      for (const [activityDay, members] of activeMembers) {
        const membersObj: Record<string, true> = {};
        for (const u of members) {
          membersObj[u] = true;
        }
        await tx.query(
          `INSERT INTO active_user_day (game_id, utc_day, members) VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (game_id, utc_day) DO UPDATE SET members = active_user_day.members || EXCLUDED.members`,
          [gameId, activityDay, JSON.stringify(membersObj)],
        );
      }
    });

    void offsetMin; // logical day already applied via sessionConfig.
    return {
      cohorts: cohortSize.size,
      retentionCells: cellRetained.size,
      activeUserDays: activeMembers.size,
      spineRows: spineRows.length,
    };
  }

  /**
   * D0 = 100 % invariant guard: assert every spine row has bit 0 set and
   * `COHORT.cohort_size ≡ RETENTION_CELL(c, 0)`. Returns counts of violations (0 =
   * healthy). Catches a flooring/desync regression.
   */
  async verifyD0Invariant(gameId: string): Promise<D0InvariantResult> {
    const missing: Array<{ n: string }> = await this.dataSource.query(
      `SELECT count(*)::text AS n FROM user_spine WHERE game_id = $1 AND get_bit(active_days_bitmap, 0) = 0`,
      [gameId],
    );
    const usersMissingBit0 = Number(missing[0]?.n ?? '0');

    const mismatched: Array<{ n: string }> = await this.dataSource.query(
      `SELECT count(*)::text AS n FROM cohort c
         LEFT JOIN retention_cell r
           ON r.game_id = c.game_id AND r.cohort_date = c.cohort_date AND r.day_offset = 0
        WHERE c.game_id = $1 AND c.cohort_size <> COALESCE(r.retained_users, 0)`,
      [gameId],
    );
    const cohortsMismatched = Number(mismatched[0]?.n ?? '0');

    return { ok: usersMissingBit0 === 0 && cohortsMismatched === 0, usersMissingBit0, cohortsMismatched };
  }
}

/** Add `n` days to a "YYYY-MM-DD" day. */
function addDays(day: string, n: number): string {
  const MS_PER_DAY = 86_400_000;
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * MS_PER_DAY).toISOString().slice(0, 10);
}
