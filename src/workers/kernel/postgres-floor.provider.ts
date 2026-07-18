/**
 * Postgres-backed FLOOR_PROVIDER (P10, T-01.28/40) — replaces `EmptyFloorProvider`.
 *
 * Rehydrate-on-miss must seed an open-day Redis bucket from its DURABLE FLOOR
 * (the last-flushed absolute in Postgres), never from 0 — otherwise a post-crash
 * flush could clobber durable results with near-zero values (DARK-SPOT #5). This
 * provider reads that floor:
 *
 *   - cntFloor(game, day)  → the per-name absolute counts already durable for
 *     that (game × utc_day) from EVENT_DAY_COUNT, as a `field → value` map keyed
 *     by event_name — exactly the shape the `cnt` hash rehydrates into (HSETNX
 *     per field, so a live HINCRBY is never clobbered).
 *   - catFloor(game, name) → the durable catalog row's fields (lifetime_count,
 *     first_seen, last_seen as epoch-ms) so the day-less `cat` hash rehydrates to
 *     the durable floor; first_seen is LEAST-merged so seeding it high is safe
 *     under the marker-skip guard, but we seed the true durable value.
 *
 * BIGINT columns come back as STRINGS from TypeORM/pg — kept as strings end to
 * end (bigint-safe; the DurableFloor contract already takes `string | number`).
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { DurableFloor } from '../../common/redis-keys/rehydrate';
import type { FloorProvider } from './default-hooks';
import { EventDayCountEntity } from '../../database/entities/event-day-count.entity';
import { EventCatalogEntity } from '../../database/entities/event-catalog.entity';
import { ExceptionTallyEntity } from '../../database/entities/exception-tally.entity';

/** Reserved cat hash fields (must match the hot-update writer's field names). */
export const CAT_FIELD_FIRST_SEEN = 'first_seen';
export const CAT_FIELD_LAST_SEEN = 'last_seen';
export const CAT_FIELD_COUNT = 'count';

@Injectable()
export class PostgresFloorProvider implements FloorProvider {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Floor for a `{game_id}:cnt:{utc_day}` hash: every durable per-name count for
   * that day. Fields are event names; values are absolute counts (string form).
   */
  async cntFloor(gameId: string, utcDay: string): Promise<DurableFloor> {
    const rows = await this.dataSource.getRepository(EventDayCountEntity).find({
      where: { gameId, utcDay },
      select: { eventName: true, count: true },
    });
    const fields: Record<string, string> = {};
    for (const row of rows) {
      fields[row.eventName] = row.count;
    }
    return { fields };
  }

  /**
   * Floor for a `{game_id}:cat:{event_name}` hash: the durable catalog absolutes.
   * Timestamps are stored as epoch-ms strings in the hash (the hot path merges
   * min/max numerically). Missing row → empty floor (seeds to nothing; the first
   * increment establishes the values).
   */
  async catFloor(gameId: string, eventName: string): Promise<DurableFloor> {
    const row = await this.dataSource.getRepository(EventCatalogEntity).findOne({
      where: { gameId, eventName },
      select: { lifetimeCount: true, firstSeen: true, lastSeen: true },
    });
    if (!row) {
      return { fields: {} };
    }
    return {
      fields: {
        [CAT_FIELD_COUNT]: row.lifetimeCount,
        [CAT_FIELD_FIRST_SEEN]: String(row.firstSeen.getTime()),
        [CAT_FIELD_LAST_SEEN]: String(row.lastSeen.getTime()),
      },
    };
  }

  /**
   * Floor for a `{game_id}:cnt:{utc_day}:exc` hash: every durable per-reason tally
   * for that arrival day from EXCEPTION_TALLY. Fields are reason names; values are
   * absolute counts (string form).
   */
  async excFloor(gameId: string, utcDay: string): Promise<DurableFloor> {
    const rows = await this.dataSource.getRepository(ExceptionTallyEntity).find({
      where: { gameId, utcDay },
      select: { reason: true, count: true },
    });
    const fields: Record<string, string> = {};
    for (const row of rows) {
      fields[row.reason] = row.count;
    }
    return { fields };
  }
}
