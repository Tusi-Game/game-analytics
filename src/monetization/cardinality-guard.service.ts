/**
 * Per-dimension observed-value cardinality guard ([006-monetization] design "Cardinality
 * guard"). Client-supplied dim values (region, in_game_state, level_bucket, …) are an
 * attack/sprawl surface — a buggy/hostile client can emit unbounded distinct values,
 * exploding MONETIZATION_CELL's dim_combo key-space. This guard mirrors the catalog
 * name-cap / economy currency-cap drop-and-count posture (but KEEPS + counts, R3):
 *
 *   Per game × dimension, the first `monetization_dimension_value_cap` (default 50)
 *   distinct observed values are first-class dim_combo components; every value beyond
 *   the cap collapses to the literal `other` (distinct from `unknown` = not supplied).
 *
 * Tracked in a `{game_id}:mon:dimcard:{dim}` registry SET, one admit-or-overflow Lua
 * EVAL per value so two workers racing the cap boundary cannot both admit the
 * (cap+1)-th value. SERVER dims are EXEMPT (payer_tier/install_cohort/days_since_install
 * are platform-derived, bounded by construction) — callers only pass client values here.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { MonKeys } from './mon-keys';
import { OTHER_VALUE } from './dim-combo';
import { MonetizationConfigService } from './monetization-config.service';

/**
 * Atomic admit-or-overflow for a client dimension value.
 *   KEYS[1] = mon:dimcard:{dim} set
 *   ARGV[1] = candidate value
 *   ARGV[2] = cap (integer, as string)
 *   ARGV[3] = the literal `other` overflow value
 * Returns the value to key under (the value itself, or `other`). Never drops.
 */
const ADMIT_OR_OVERFLOW_LUA = `
local value = ARGV[1]
local cap = tonumber(ARGV[2])
local other = ARGV[3]
if value == other then
  return other
end
if redis.call('SISMEMBER', KEYS[1], value) == 1 then
  return value
end
local size = redis.call('SCARD', KEYS[1])
if size < cap then
  redis.call('SADD', KEYS[1], value)
  return value
end
return other
`;

@Injectable()
export class CardinalityGuardService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly config: MonetizationConfigService,
  ) {}

  /**
   * Resolve one client dimension value to key under: the value itself (known or newly
   * admitted under cap), or the literal `other` overflow. Never drops. An empty value
   * is returned as-is (the caller renders it `unknown` in dim-combo, not `other`).
   */
  async resolveValue(gameId: string, dimension: string, value: string): Promise<string> {
    if (value === '') {
      return value;
    }
    const cap = await this.config.dimensionValueCap(gameId);
    const key = MonKeys.dimCard(gameId, dimension);
    const resolved = await this.redis.eval(ADMIT_OR_OVERFLOW_LUA, 1, key, value, String(cap), OTHER_VALUE);
    return typeof resolved === 'string' ? resolved : OTHER_VALUE;
  }
}
