/**
 * Step-8 hot-update hook for `kind = session` (T-02.19..21, T-04.15/16/17).
 * Registered with the kind dispatcher under KIND_HOT_REGISTRATION.
 *
 * COMPOSITION CONTRACT (kind-dispatch.ts): the dispatcher runs the GENERIC
 * cat/cnt/rank base FIRST, then THIS hook. So this hook implements ONLY the
 * session/retention accumulators (sess / act / ret) — it MUST NOT redo cat/cnt/rank.
 *
 * All buckets rehydrate-on-miss from the story's OWN durable floor
 * ({@link SessionFloorProvider}) and dirty-mark for the flusher. Everything here
 * is transient-and-losable (Foundation §6); the durable spine bit already landed
 * in step 7 (durable ≺ hot), so a Redis loss can only lag the spine, never lead it.
 *
 *   {game}:sess:{start_day}  hash  session_count += 1, sessions_touching += 1,
 *                                  duration_sum_ms += dur_on_day(start_day)
 *   {game}:sess:{end_day}    hash  (iff 2nd-day overlap) sessions_touching += 1,
 *                                  duration_sum_ms += dur_on_day(end_day) — NO count
 *   {game}:act:{start_day}   set   SADD user_id (start-day only; activeness)
 *   {game}:ret:{c}           hash  size += 1        (iff 7a created the row — 8a)
 *   {game}:ret:{d}           hash  cell:{c}:{off} += 1 (iff 7b′ 0→1 transition — 8b),
 *                                  d = c + off = this event's own start day
 *
 * The `created`/`bitTransition`/`offset`/`cohortDate`/trusted interval are all read
 * off the branded step-7 token — never recomputed here (the two steps cannot drift).
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import type { RoutedRecord } from '../common/contracts/queue-jobs';
import type {
  DedupPassedToken,
  DurableWrittenToken,
  HotUpdatedToken,
  HotUpdateHook,
} from '../workers/kernel/pipeline-steps';
import { RehydrateService } from '../common/redis-keys/rehydrate';
import { DirtyRegistry } from '../workers/flush/dirty-registry';
import { SessionConfigService } from './session-config.service';
import { SessionFloorProvider } from './session-floor.provider';
import { readSessionDurableState } from './session-durable.hook';
import { durOnDay } from './session-time';
import {
  SessionKeys,
  SESS_FIELD_SESSION_COUNT,
  SESS_FIELD_DURATION_SUM_MS,
  SESS_FIELD_SESSIONS_TOUCHING,
  RET_FIELD_SIZE,
  retCellField,
} from './session-keys';

@Injectable()
export class SessionHotHook implements HotUpdateHook {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly rehydrate: RehydrateService,
    private readonly dirty: DirtyRegistry,
    private readonly floors: SessionFloorProvider,
    private readonly sessionConfig: SessionConfigService,
  ) {}

  async update(
    record: RoutedRecord,
    _bucketName: string,
    _dedup: DedupPassedToken,
    durable: DurableWrittenToken,
  ): Promise<HotUpdatedToken> {
    const state = readSessionDurableState(durable);
    // Defensive: only session records carry the branded state. If absent (should
    // not happen — the dispatcher only routes session here after our durable hook),
    // do nothing rather than crash the pipeline.
    if (!state) {
      return {} as HotUpdatedToken;
    }

    const gameId = record.envelope.game_id;
    const offsetMin = this.sessionConfig.reportingOffsetMinutes();
    const { session } = state;
    const interval = { correctedStart: session.correctedStart, trustedEnd: session.trustedEnd };

    // ---- sess:{start_day} — count + touching + start-day duration split ------
    const sessStartKey = SessionKeys.sess(gameId, session.startDay);
    await this.rehydrate.seedIfMissing(sessStartKey, await this.floors.sessFloor(gameId, session.startDay));
    const startDur = durOnDay(interval, session.startDay, offsetMin);
    await this.redis.hincrby(sessStartKey, SESS_FIELD_SESSION_COUNT, 1);
    await this.redis.hincrby(sessStartKey, SESS_FIELD_SESSIONS_TOUCHING, 1);
    if (startDur > 0) {
      await this.redis.hincrby(sessStartKey, SESS_FIELD_DURATION_SUM_MS, startDur);
    }
    await this.dirty.mark('sess', sessStartKey);

    // ---- sess:{end_day} — 2nd-day tail: touching + duration, NO count --------
    if (session.endDay !== null) {
      const sessEndKey = SessionKeys.sess(gameId, session.endDay);
      await this.rehydrate.seedIfMissing(sessEndKey, await this.floors.sessFloor(gameId, session.endDay));
      const endDur = durOnDay(interval, session.endDay, offsetMin);
      await this.redis.hincrby(sessEndKey, SESS_FIELD_SESSIONS_TOUCHING, 1);
      if (endDur > 0) {
        await this.redis.hincrby(sessEndKey, SESS_FIELD_DURATION_SUM_MS, endDur);
      }
      await this.dirty.mark('sess', sessEndKey);
    }

    // ---- act:{start_day} — SADD the user (start-day only; client sessions) ----
    // Only a spine-anchored client session sets activeness. `offset === undefined`
    // with a present user means the bit was skipped (negative/over-horizon) — the
    // session still counts, but a negative-offset event must NOT mark activeness on
    // a day that pre-dates first_seen. We SADD only when a user_id exists AND the
    // event was eligible to touch the spine (offset defined ⇒ in-range, client).
    const userId = record.envelope.user_id;
    if (record.provenance === 'client' && typeof userId === 'string' && userId.length > 0) {
      // `act` is a HASH-as-set (field = user_id, value = "1") — exact membership,
      // reusing the standard hash rehydrate + marker + hgetall flush unmodified.
      const actKey = SessionKeys.act(gameId, session.startDay);
      await this.rehydrate.seedIfMissing(actKey, await this.floors.actFloor(gameId, session.startDay));
      await this.redis.hset(actKey, userId, '1');
      await this.dirty.mark('act', actKey);
    }

    // ---- ret:{c} size += 1 — 8a, iff 7a created the spine row -----------------
    if (state.created) {
      const c = state.cohortDate;
      const retCohortKey = SessionKeys.ret(gameId, c);
      await this.rehydrate.seedIfMissing(retCohortKey, await this.floors.retFloor(gameId, c));
      await this.redis.hincrby(retCohortKey, RET_FIELD_SIZE, 1);
      await this.dirty.mark('ret', retCohortKey);
    }

    // ---- ret:{d} cell:{c}:{off} += 1 — 8b, iff 7b′ reported a 0→1 transition --
    if (state.bitTransition && state.offset !== undefined) {
      const c = state.cohortDate;
      // d = c + offset = this event's own corrected start day (open — passed step 5).
      const d = session.startDay;
      const retActivityKey = SessionKeys.ret(gameId, d);
      await this.rehydrate.seedIfMissing(retActivityKey, await this.floors.retFloor(gameId, d));
      await this.redis.hincrby(retActivityKey, retCellField(c, state.offset), 1);
      await this.dirty.mark('ret', retActivityKey);
    }

    return {} as HotUpdatedToken;
  }
}
