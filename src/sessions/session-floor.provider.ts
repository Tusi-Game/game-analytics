/**
 * Per-domain durable FLOOR provider for the session/retention hot path
 * (rehydrate-on-miss, Foundation §2.3). This is the seam's floor-extension
 * pattern (default-hooks.ts): the story INJECTS ITS OWN floor provider scoped to
 * its domains (`sess`/`act`/`ret`) and calls it directly inside the story hot
 * hook — it NEVER touches the generic {@link FloorProvider} (cnt/cat/exc), so
 * there is no shared mutation point (collision-free by construction).
 *
 * A missing durable row → an empty floor; the first hot increment establishes the
 * value on top of the durable floor (HSETNX seed → HINCRBY / SADD).
 *
 *   - {@link sessFloor}  `{game}:sess:{day}`  ← SESSION_DAY_RESULT (3 counters)
 *   - {@link actFloor}   `{game}:act:{day}`   ← ACTIVE_USER_DAY.members (set)
 *   - {@link retFloor}   `{game}:ret:{day}`   ← RETENTION_CELL cells + COHORT size
 *                        for every cohort×offset whose activity day == this day.
 *
 * BIGINT columns come back as STRINGS from TypeORM and stay strings end-to-end.
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { DurableFloor } from '../common/redis-keys/rehydrate';
import { SessionDayResultEntity } from '../database/entities/session-day-result.entity';
import { ActiveUserDayEntity } from '../database/entities/active-user-day.entity';
import { CohortEntity } from '../database/entities/cohort.entity';
import {
  SESS_FIELD_SESSION_COUNT,
  SESS_FIELD_DURATION_SUM_MS,
  SESS_FIELD_SESSIONS_TOUCHING,
  RET_FIELD_SIZE,
  retCellField,
} from './session-keys';

@Injectable()
export class SessionFloorProvider {
  constructor(private readonly dataSource: DataSource) {}

  /** Floor for a `sess` hash: the durable per-day session counters (0 if absent). */
  async sessFloor(gameId: string, utcDay: string): Promise<DurableFloor> {
    const row = await this.dataSource.getRepository(SessionDayResultEntity).findOne({
      where: { gameId, utcDay },
      select: { sessionCount: true, durationSumMs: true, sessionsTouching: true },
    });
    if (!row) {
      return { fields: {} };
    }
    return {
      fields: {
        [SESS_FIELD_SESSION_COUNT]: row.sessionCount,
        [SESS_FIELD_DURATION_SUM_MS]: row.durationSumMs,
        [SESS_FIELD_SESSIONS_TOUCHING]: row.sessionsTouching,
      },
    };
  }

  /**
   * Floor for an `act` bucket: the durable exact member set. The bucket is
   * realized as a Redis HASH-as-set (field = user_id, value = "1") so it reuses
   * the standard hash rehydrate + `seeded`-marker + `hgetall` flush machinery
   * unmodified (a raw Redis SET cannot also carry the hash `seeded` marker on the
   * same key — WRONGTYPE). Membership stays EXACT (never HLL — Foundation §2.2).
   */
  async actFloor(gameId: string, utcDay: string): Promise<DurableFloor> {
    const row = await this.dataSource.getRepository(ActiveUserDayEntity).findOne({
      where: { gameId, utcDay },
      select: { members: true },
    });
    const fields: Record<string, string> = {};
    for (const member of Object.keys(row?.members ?? {})) {
      fields[member] = '1';
    }
    return { fields };
  }

  /**
   * Floor for a `ret` hash (BUCKET-DAY rule): the durable retention cells + cohort
   * size whose ACTIVITY day equals `utcDay`. A cell `RETENTION_CELL(c, N)` lands in
   * bucket `c + N`; the cohort born on `utcDay` contributes `size`. We read every
   * durable cell whose `cohort_date + day_offset = utcDay` plus the COHORT row for
   * `cohort_date = utcDay`.
   */
  async retFloor(gameId: string, utcDay: string): Promise<DurableFloor> {
    const fields: Record<string, string> = {};

    // COHORT.size for the cohort born on this bucket day (offset-0 anchor).
    const cohort = await this.dataSource.getRepository(CohortEntity).findOne({
      where: { gameId, cohortDate: utcDay },
      select: { cohortSize: true },
    });
    if (cohort) {
      fields[RET_FIELD_SIZE] = cohort.cohortSize;
    }

    // Every durable retention cell whose activity day (cohort_date + day_offset)
    // equals this bucket day. Computed in SQL to avoid scanning all cells.
    const cells: Array<{ cohort_date: string; day_offset: number; retained_users: string }> =
      await this.dataSource.query(
        `SELECT cohort_date::text AS cohort_date, day_offset, retained_users
           FROM retention_cell
          WHERE game_id = $1
            AND (cohort_date + (day_offset || ' days')::interval)::date = $2::date`,
        [gameId, utcDay],
      );
    for (const cell of cells) {
      fields[retCellField(cell.cohort_date, cell.day_offset)] = cell.retained_users;
    }

    return { fields };
  }
}
