/**
 * Exception-tally read model (T-11.42/74) — the panel surface over EXCEPTION_TALLY
 * that no sibling read service exposed (research brief §9 blocker 4). It merges
 * the durable EXCEPTION_TALLY rows (Postgres) with the live open-day Redis hash
 * `{game}:cnt:{arrival_day}:exc` using the SAME §3.3 GREATEST-per-cell merge as
 * {@link ReadModelService.dayCounts} — the live hash rehydrated from the durable
 * floor, so it already includes it; take the max, never a sum.
 *
 * The reason vocabulary is the Foundation §1.2 12-reason enum ({@link
 * EXCEPTION_REASONS}), declared ONCE in `common/contracts/exception-reason.ts` and
 * reused here (never redeclared). Reserved Redis metadata fields (`__seeded`,
 * `__game_id`, `__utc_day`) are stripped.
 *
 * Pure reader — writes nothing (P9). Tallies are ARRIVAL-day bucketed (the writer
 * keys them on the server-received day), so the read is by arrival day too.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { IngestKeys } from '../common/redis-keys/redis-keys';
import { SEEDED_MARKER_FIELD } from '../common/redis-keys/rehydrate';
import { EXC_FIELD_GAME_ID, EXC_FIELD_UTC_DAY } from '../workers/kernel/exception-tally.writer';
import { ExceptionTallyEntity } from '../database/entities/exception-tally.entity';
import { EXCEPTION_REASONS, isExceptionReason, type ExceptionReason } from '../common/contracts/exception-reason';

/** Per-reason exception counts for a game × arrival day, plus provisional flag. */
export interface ExceptionDayView {
  gameId: string;
  utcDay: string;
  /** reason → merged (GREATEST) count. Only reasons with a non-zero count appear. */
  perReason: Partial<Record<ExceptionReason, number>>;
  /** Read-time Σ over `perReason`. */
  total: number;
  /** True iff any live (Redis) value contributed → the figure is provisional. */
  provisional: boolean;
}

@Injectable()
export class ExceptionReadService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly dataSource: DataSource,
  ) {}

  /** The canonical ordered reason vocabulary (Foundation §1.2). */
  reasons(): readonly ExceptionReason[] {
    return EXCEPTION_REASONS;
  }

  /**
   * Merged per-reason exception counts for a game × arrival day:
   * GREATEST(live Redis, durable Postgres) per reason. Grand total is a read-time Σ.
   */
  async exceptionDay(gameId: string, utcDay: string): Promise<ExceptionDayView> {
    const [live, durable] = await Promise.all([this.liveExc(gameId, utcDay), this.durableExc(gameId, utcDay)]);

    const perReason: Partial<Record<ExceptionReason, number>> = { ...durable };
    let provisional = false;
    for (const [reason, liveVal] of Object.entries(live) as Array<[ExceptionReason, number]>) {
      provisional = true;
      const durableVal = perReason[reason] ?? 0;
      perReason[reason] = Math.max(liveVal, durableVal);
    }

    const total = Object.values(perReason).reduce((sum: number, v) => sum + (v ?? 0), 0);
    return { gameId, utcDay, perReason, total, provisional };
  }

  /** Merged per-reason counts over an inclusive day window [from, to]. */
  async exceptionWindow(gameId: string, from: string, to: string): Promise<ExceptionDayView[]> {
    const out: ExceptionDayView[] = [];
    for (const day of enumerateDays(from, to)) {
      out.push(await this.exceptionDay(gameId, day));
    }
    return out;
  }

  /** Live per-reason counts from the open-day `cnt:exc` hash (reserved fields stripped). */
  private async liveExc(gameId: string, utcDay: string): Promise<Partial<Record<ExceptionReason, number>>> {
    const hash = await this.redis.hgetall(IngestKeys.cntExc(gameId, utcDay));
    const out: Partial<Record<ExceptionReason, number>> = {};
    for (const [field, value] of Object.entries(hash)) {
      if (field === SEEDED_MARKER_FIELD || field === EXC_FIELD_GAME_ID || field === EXC_FIELD_UTC_DAY) {
        continue;
      }
      if (!isExceptionReason(field)) {
        continue;
      }
      const n = Number(value);
      if (Number.isFinite(n)) {
        out[field] = n;
      }
    }
    return out;
  }

  /** Durable per-reason counts from EXCEPTION_TALLY for the arrival day. */
  private async durableExc(gameId: string, utcDay: string): Promise<Partial<Record<ExceptionReason, number>>> {
    const rows = await this.dataSource.getRepository(ExceptionTallyEntity).find({
      where: { gameId, utcDay },
      select: { reason: true, count: true },
    });
    const out: Partial<Record<ExceptionReason, number>> = {};
    for (const row of rows) {
      if (!isExceptionReason(row.reason)) {
        continue;
      }
      const n = Number(row.count);
      out[row.reason] = Number.isFinite(n) ? n : 0;
    }
    return out;
  }
}

/** Inclusive list of "YYYY-MM-DD" days from `from` to `to`. */
function enumerateDays(from: string, to: string): string[] {
  const MS_PER_DAY = 86_400_000;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const days: string[] = [];
  for (let t = start; t <= end && days.length < 366; t += MS_PER_DAY) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}
