/**
 * Economy currency observed-value cap gate (R3 other-overflow, §H-4 generalized to
 * currencies, T-03.15/16). Mirrors {@link RedisNameCapGate} for the `eco:cur`
 * currency registry.
 *
 * Per game, distinct CURRENCY ids are budgeted by `economy_currency_cap_per_game`
 * (default 500). The budget is tracked in the day-less `{game_id}:eco:cur` Redis
 * SET (a currency is "known" iff it is a member; the set is also the dashboard
 * currency picker).
 *
 *   - currency already known                → return it (buckets under itself);
 *   - currency new AND set size < cap        → admit it (SADD) and return it;
 *   - currency new AND set already at cap     → return the literal `other` bucket.
 *
 * R3 (plan.md ruling — supersedes the STALE spec.md:169 / design.md:100 step-3
 * "drop-and-tally capexceeded"): an over-cap distinct currency is NOT dropped —
 * its events are KEPT + counted under `other`. This gate can only ever return the
 * currency or `other`; it NEVER drops. `other` ≠ `unknown` (`unknown` = the field
 * was absent → that quarantines at step 3; `other` = over-budget but present).
 *
 * The admit-or-overflow decision is one atomic Lua EVAL so two workers racing on
 * the cap boundary cannot both admit the (cap+1)-th distinct currency. `other`
 * itself is always admitted (a first-class kept bucket) so it never ambiguously
 * consumes a budget slot.
 *
 * NOTE (allowlist interaction): when `economy_currency_allowlist` is non-empty and
 * the currency is NOT in it, the step-3 validator QUARANTINES the event BEFORE
 * this gate is ever consulted (T-03.14) — so a disallowed currency never reaches
 * the registry. This gate only runs for currencies that already passed allowlist.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { GameConfigService } from '../config/game-config.service';
import { EcoKeys, OTHER_CURRENCY } from './eco-keys';

/** Default per-game distinct-currency cap (forward-only; §H-4 posture). */
export const DEFAULT_ECONOMY_CURRENCY_CAP_PER_GAME = 500;

/**
 * Atomic admit-or-overflow.
 *   KEYS[1] = eco:cur set
 *   ARGV[1] = candidate currency
 *   ARGV[2] = cap (integer, as string)
 *   ARGV[3] = the literal `other` overflow currency
 * Returns the currency to bucket under.
 */
const ADMIT_OR_OVERFLOW_LUA = `
local currency = ARGV[1]
local cap = tonumber(ARGV[2])
local other = ARGV[3]
if currency == other then
  redis.call('SADD', KEYS[1], other)
  return other
end
if redis.call('SISMEMBER', KEYS[1], currency) == 1 then
  return currency
end
local size = redis.call('SCARD', KEYS[1])
if size < cap then
  redis.call('SADD', KEYS[1], currency)
  return currency
end
-- Over cap: bucket under the other-overflow (KEPT + counted, R3). Register it in
-- the picker set so the dashboard surfaces the overflow bucket; it does not consume
-- a first-class budget slot (it is not a distinct user currency).
redis.call('SADD', KEYS[1], other)
return other
`;

@Injectable()
export class EcoCurrencyCapGate {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly gameConfig: GameConfigService,
  ) {}

  /**
   * Resolve a currency to bucket under: the currency itself (known or newly
   * admitted under cap), or the literal `other` overflow bucket. Never drops.
   */
  async resolveCurrency(gameId: string, currency: string): Promise<string> {
    const cap = await this.capFor(gameId);
    const key = EcoKeys.ecoCur(gameId);
    const resolved = await this.redis.eval(ADMIT_OR_OVERFLOW_LUA, 1, key, currency, String(cap), OTHER_CURRENCY);
    return typeof resolved === 'string' ? resolved : OTHER_CURRENCY;
  }

  /** Effective cap for a game: per-game §6 knob → default (forward-only). */
  private async capFor(gameId: string): Promise<number> {
    const perGame = await this.gameConfig.getNumber(gameId, 'economy_currency_cap_per_game');
    return perGame !== undefined ? perGame : DEFAULT_ECONOMY_CURRENCY_CAP_PER_GAME;
  }
}
