/**
 * Dashboard read-model surface (T-01.41, foundation §3.3) — the thin live-vs-
 * historical merge the panel (spec 012) reads.
 *
 * The merge (§3.3, applied once, uniformly): for a game and day,
 *   - the CURRENT open day is served LIVE from the `{game_id}:cnt:{utc_day}` Redis
 *     hash (per-name counts + read-time Σ grand total), labeled PROVISIONAL
 *     (≤ flush-cadence drift);
 *   - a SEALED/past day is served from Postgres EVENT_DAY_COUNT (durable, final);
 *   - a merged view sums BOTH sources per name so a day mid-flush is never
 *     double-counted NOR under-counted at the boundary: the live hash is the
 *     absolute (it rehydrated from the durable floor), so where both exist the
 *     LIVE value already includes the durable floor → we take GREATEST per name,
 *     matching the class-M merge (never sum the two, that would double-count the
 *     floor).
 *
 * This is the MERGE + read function only; the full panel (rendering, top-N ties,
 * catalog browser, drift indicator) is spec 012. Grand total is a read-time Σ (no
 * stored cell, OF-3).
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { IngestKeys } from '../common/redis-keys/redis-keys';
import { SEEDED_MARKER_FIELD } from '../common/redis-keys/rehydrate';
import { EventDayCountEntity } from '../database/entities/event-day-count.entity';

/** Per-name counts for a game×day plus the read-time Σ grand total. */
export interface DayCounts {
  gameId: string;
  utcDay: string;
  /** event_name → absolute count. */
  perName: Record<string, number>;
  /** Read-time Σ over `perName` (no stored cell, OF-3). */
  liveTotal: number;
  /** Whether any live (Redis) value contributed → the figure is provisional. */
  provisional: boolean;
}

@Injectable()
export class ReadModelService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Merged per-name counts for a game×day: GREATEST(live Redis, durable Postgres)
   * per name (never a sum — the live hash rehydrated from the durable floor, so it
   * already includes it; class-M semantics). Grand total is the read-time Σ.
   */
  async dayCounts(gameId: string, utcDay: string): Promise<DayCounts> {
    const [live, durable] = await Promise.all([this.liveCnt(gameId, utcDay), this.durableCnt(gameId, utcDay)]);

    const perName: Record<string, number> = { ...durable };
    let provisional = false;
    for (const [name, liveVal] of Object.entries(live)) {
      provisional = true;
      const durableVal = perName[name] ?? 0;
      // GREATEST — live is the absolute (rehydrated from the floor); take the max
      // so a torn-low live read self-heals against the durable floor.
      perName[name] = Math.max(liveVal, durableVal);
    }

    const liveTotal = Object.values(perName).reduce((sum, v) => sum + v, 0);
    return { gameId, utcDay, perName, liveTotal, provisional };
  }

  /** Live per-name counts from the open-day `cnt` hash (reserved fields stripped). */
  private async liveCnt(gameId: string, utcDay: string): Promise<Record<string, number>> {
    const hash = await this.redis.hgetall(IngestKeys.cnt(gameId, utcDay));
    const out: Record<string, number> = {};
    for (const [field, value] of Object.entries(hash)) {
      if (field === SEEDED_MARKER_FIELD) {
        continue;
      }
      const n = Number(value);
      if (Number.isFinite(n)) {
        out[field] = n;
      }
    }
    return out;
  }

  /** Durable per-name counts from EVENT_DAY_COUNT for the day. */
  private async durableCnt(gameId: string, utcDay: string): Promise<Record<string, number>> {
    const rows = await this.dataSource.getRepository(EventDayCountEntity).find({
      where: { gameId, utcDay },
      select: { eventName: true, count: true },
    });
    const out: Record<string, number> = {};
    for (const row of rows) {
      const n = Number(row.count);
      out[row.eventName] = Number.isFinite(n) ? n : 0;
    }
    return out;
  }
}
