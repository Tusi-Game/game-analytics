/**
 * Session read model (T-02.23/24, [003-sessions] design read-model) — READ-TIME
 * only; nothing here is stored.
 *
 *   session count / day     = SESSION_DAY_RESULT.session_count
 *   avg session length / day = duration_sum_ms / sessions_touching  (SPLIT form,
 *                              labelled §S-4 default)
 *   sessions per user (W)    = Σ session_count over W / |union ACTIVE_USER_DAY.members|
 *   session frequency (W)    = Σ session_count over W / Σ per-day |members|
 *
 * Merge (Foundation §3.3): sealed days from Postgres; the current open day is
 * live-merged from the `sess`/`act` buckets with GREATEST per cell (the live hash
 * rehydrated from the durable floor). A window touching an open day is PROVISIONAL.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { SessionDayResultEntity } from '../database/entities/session-day-result.entity';
import { ActiveUserDayEntity } from '../database/entities/active-user-day.entity';
import { SessionConfigService } from './session-config.service';
import {
  SessionKeys,
  SESS_FIELD_SESSION_COUNT,
  SESS_FIELD_DURATION_SUM_MS,
  SESS_FIELD_SESSIONS_TOUCHING,
} from './session-keys';

/** Per-day session figures (split-form average is the default §S-4). */
export interface SessionDayView {
  gameId: string;
  utcDay: string;
  sessionCount: number;
  durationSumMs: number;
  sessionsTouching: number;
  /** Split-form average = durationSumMs / sessionsTouching (0 if no touching). */
  avgSessionLengthMs: number;
  /** True iff any live (open-day) value contributed. */
  provisional: boolean;
}

/** Sessions-per-user + frequency over a window. */
export interface SessionWindowView {
  gameId: string;
  from: string;
  to: string;
  totalSessions: number;
  distinctUsers: number;
  activeUserDays: number;
  /** totalSessions / distinctUsers (0 if none). */
  sessionsPerUser: number;
  /** totalSessions / activeUserDays (0 if none). */
  sessionFrequency: number;
  provisional: boolean;
}

@Injectable()
export class SessionReadService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly dataSource: DataSource,
    private readonly sessionConfig: SessionConfigService,
  ) {}

  /** Merged per-day session figures (GREATEST live vs durable per counter). */
  async sessionDay(gameId: string, utcDay: string, now: number = Date.now()): Promise<SessionDayView> {
    const durable = await this.dataSource.getRepository(SessionDayResultEntity).findOne({
      where: { gameId, utcDay },
      select: { sessionCount: true, durationSumMs: true, sessionsTouching: true },
    });
    let sessionCount = durable ? Number(durable.sessionCount) : 0;
    let durationSumMs = durable ? Number(durable.durationSumMs) : 0;
    let sessionsTouching = durable ? Number(durable.sessionsTouching) : 0;

    let provisional = false;
    const today = this.sessionConfig.todayLogical(now);
    if (utcDay >= today) {
      const live = await this.redis.hgetall(SessionKeys.sess(gameId, utcDay));
      delete live['__seeded'];
      if (Object.keys(live).length > 0) {
        provisional = true;
        sessionCount = Math.max(sessionCount, Number(live[SESS_FIELD_SESSION_COUNT] ?? 0));
        durationSumMs = Math.max(durationSumMs, Number(live[SESS_FIELD_DURATION_SUM_MS] ?? 0));
        sessionsTouching = Math.max(sessionsTouching, Number(live[SESS_FIELD_SESSIONS_TOUCHING] ?? 0));
      }
    }

    return {
      gameId,
      utcDay,
      sessionCount,
      durationSumMs,
      sessionsTouching,
      avgSessionLengthMs: sessionsTouching > 0 ? durationSumMs / sessionsTouching : 0,
      provisional,
    };
  }

  /**
   * Sessions-per-user + frequency over the inclusive day window [from, to].
   * distinctUsers = |union of ACTIVE_USER_DAY.members over W| (exact set union,
   * never HLL for membership); activeUserDays = Σ per-day |members|.
   */
  async window(gameId: string, from: string, to: string, now: number = Date.now()): Promise<SessionWindowView> {
    const days = enumerateDays(from, to);
    const union = new Set<string>();
    let totalSessions = 0;
    let activeUserDays = 0;
    let provisional = false;

    for (const day of days) {
      const dayView = await this.sessionDay(gameId, day, now);
      totalSessions += dayView.sessionCount;
      provisional = provisional || dayView.provisional;
      const members = await this.activeMembers(gameId, day, now);
      activeUserDays += members.size;
      for (const u of members) {
        union.add(u);
      }
    }

    const distinctUsers = union.size;
    return {
      gameId,
      from,
      to,
      totalSessions,
      distinctUsers,
      activeUserDays,
      sessionsPerUser: distinctUsers > 0 ? totalSessions / distinctUsers : 0,
      sessionFrequency: activeUserDays > 0 ? totalSessions / activeUserDays : 0,
      provisional,
    };
  }

  /** Merged exact member set for a day (durable object-map ∪ live hash-as-set). */
  private async activeMembers(gameId: string, day: string, now: number): Promise<Set<string>> {
    const set = new Set<string>();
    const durable = await this.dataSource.getRepository(ActiveUserDayEntity).findOne({
      where: { gameId, utcDay: day },
      select: { members: true },
    });
    for (const u of Object.keys(durable?.members ?? {})) {
      set.add(u);
    }
    const today = this.sessionConfig.todayLogical(now);
    if (day >= today) {
      const live = await this.redis.hgetall(SessionKeys.act(gameId, day));
      delete live['__seeded'];
      for (const u of Object.keys(live)) {
        set.add(u);
      }
    }
    return set;
  }
}

/** Inclusive list of "YYYY-MM-DD" days from `from` to `to`. */
function enumerateDays(from: string, to: string): string[] {
  const MS_PER_DAY = 86_400_000;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const days: string[] = [];
  for (let t = start; t <= end; t += MS_PER_DAY) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}
