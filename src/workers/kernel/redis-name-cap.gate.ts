/**
 * Redis-set name-cap gate (R3 other-overflow, §H-4, T-01.23/30) — replaces
 * `UncappedNameGate`.
 *
 * Per game, distinct EVENT NAMES are budgeted by `event_name_cap_per_game`
 * (default 500). The budget is tracked in the day-less `{game_id}:cat:names`
 * Redis SET (a name is "known" iff it is a member).
 *
 *   - name already known → return it (buckets under its own name);
 *   - name new AND set size < cap → admit it (SADD) and return it;
 *   - name new AND set already at cap → return the literal `other` bucket.
 *
 * R3 (plan.md, the ONE live contradiction in 002): an over-cap distinct name is
 * NOT dropped — its events are KEPT + counted under `other`. The stale
 * design.md/tasks.md "drop-and-tally capexceeded" posture is superseded. This
 * gate can only ever return the name or `other`; it NEVER drops (never throws for
 * over-cap).
 *
 * The admit-or-overflow decision is done in ONE atomic Lua EVAL so two workers
 * racing on the cap boundary cannot both admit the (cap+1)-th distinct name.
 * `other` itself is always admitted (it is a first-class kept bucket, not a new
 * distinct user name) so it never consumes a budget slot ambiguously.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { IngestKeys } from '../../common/redis-keys/redis-keys';
import { OTHER_OVERFLOW_NAME, type NameCapGate } from './ingest-kernel';
import { GameConfigService } from '../../config/game-config.service';

/** The §6 default per-game distinct-event-name cap (forward-only). */
export const DEFAULT_EVENT_NAME_CAP_PER_GAME = 500;

/**
 * Atomic admit-or-overflow.
 *   KEYS[1] = cat:names set
 *   ARGV[1] = candidate name
 *   ARGV[2] = cap (integer, as string)
 *   ARGV[3] = the literal `other` overflow name
 * Returns the name to bucket under.
 */
const ADMIT_OR_OVERFLOW_LUA = `
local name = ARGV[1]
local cap = tonumber(ARGV[2])
local other = ARGV[3]
if name == other then
  redis.call('SADD', KEYS[1], other)
  return other
end
if redis.call('SISMEMBER', KEYS[1], name) == 1 then
  return name
end
local size = redis.call('SCARD', KEYS[1])
if size < cap then
  redis.call('SADD', KEYS[1], name)
  return name
end
return other
`;

@Injectable()
export class RedisNameCapGate implements NameCapGate {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly gameConfig: GameConfigService,
  ) {}

  async resolveName(gameId: string, eventName: string): Promise<string> {
    const cap = await this.capFor(gameId);
    const key = IngestKeys.catNames(gameId);
    const resolved = await this.redis.eval(ADMIT_OR_OVERFLOW_LUA, 1, key, eventName, String(cap), OTHER_OVERFLOW_NAME);
    return typeof resolved === 'string' ? resolved : OTHER_OVERFLOW_NAME;
  }

  /** Effective cap for a game: per-game §6 knob → env → default (forward-only). */
  private async capFor(gameId: string): Promise<number> {
    const perGame = await this.gameConfig.getNumber(gameId, 'event_name_cap_per_game');
    if (perGame !== undefined) {
      return perGame;
    }
    const envCap = this.config.get<number>('EVENT_NAME_CAP_PER_GAME');
    return typeof envCap === 'number' && Number.isFinite(envCap) ? envCap : DEFAULT_EVENT_NAME_CAP_PER_GAME;
  }
}
