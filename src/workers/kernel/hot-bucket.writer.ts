/**
 * Hot-path Redis increments for step 8 (T-01.28) — the concrete `cnt`/`cat`/`rank`
 * writes the generic hook performs after rehydrate + before dirty-mark.
 *
 * Three structures (foundation §3.1 step 8, §3.2.1):
 *   - `cnt` hash  (class M)   → HINCRBY field=bucketName by 1  (per-name day count)
 *   - `rank` zset (display)   → ZINCRBY member=bucketName by 1  (never flushed)
 *   - `cat` hash  (mixed)     → count HINCRBY, first_seen LEAST, last_seen GREATEST,
 *                               property_type_sets UNION — all in ONE atomic Lua
 *                               EVAL so a torn read can never split the min/max.
 *
 * DARK-SPOT #2: `cat.first_seen` merges by MIN (LEAST), everything else by MAX.
 * The Lua below applies min to first_seen and max to last_seen explicitly, at the
 * Redis hot layer — matching the Postgres flush merge so the two layers agree.
 *
 * The `cat` hash also carries the flush-projection metadata (`game_id`,
 * `event_name`, `kind`) via HSETNX so the flush projector can build the upsert PK
 * without re-parsing the key. Property type-sets are stored one field per key as
 * `pts:{key}` → JSON string[] so they union independently.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { IngestKeys } from '../../common/redis-keys/redis-keys';
import type { EventKind } from '../../common/contracts/envelope';
import { CAT_FIELD_COUNT, CAT_FIELD_FIRST_SEEN, CAT_FIELD_LAST_SEEN } from './postgres-floor.provider';

/** Reserved cat metadata fields (HSETNX on first write; read by the projector). */
export const CAT_FIELD_GAME_ID = 'game_id';
export const CAT_FIELD_EVENT_NAME = 'event_name';
export const CAT_FIELD_KIND = 'kind';
/** Prefix for per-property-key type-set fields in the cat hash. */
export const CAT_PTS_PREFIX = 'pts:';

/**
 * Atomic mixed-`cat` merge for one event.
 *   KEYS[1] = cat hash
 *   ARGV[1] = observed event time (epoch-ms, string)
 *   ARGV[2] = game_id
 *   ARGV[3] = event_name
 *   ARGV[4] = resolved kind
 *   ARGV[5] = number of property-type pairs that follow
 *   ARGV[6..] = repeating (ptsField, jsonTypeArray) pairs
 */
const CAT_MERGE_LUA = `
local key = KEYS[1]
local t = tonumber(ARGV[1])
-- lifetime count += 1
redis.call('HINCRBY', key, '${CAT_FIELD_COUNT}', 1)
-- first_seen = LEAST (min)
local fs = redis.call('HGET', key, '${CAT_FIELD_FIRST_SEEN}')
if fs == false or tonumber(fs) == nil or t < tonumber(fs) then
  redis.call('HSET', key, '${CAT_FIELD_FIRST_SEEN}', ARGV[1])
end
-- last_seen = GREATEST (max)
local ls = redis.call('HGET', key, '${CAT_FIELD_LAST_SEEN}')
if ls == false or tonumber(ls) == nil or t > tonumber(ls) then
  redis.call('HSET', key, '${CAT_FIELD_LAST_SEEN}', ARGV[1])
end
-- metadata: set once (never overwritten)
redis.call('HSETNX', key, '${CAT_FIELD_GAME_ID}', ARGV[2])
redis.call('HSETNX', key, '${CAT_FIELD_EVENT_NAME}', ARGV[3])
redis.call('HSETNX', key, '${CAT_FIELD_KIND}', ARGV[4])
-- property type-sets: union each key's observed types
local n = tonumber(ARGV[5])
local base = 6
for i = 0, n - 1 do
  local field = ARGV[base + i*2]
  local incoming = cjson.decode(ARGV[base + i*2 + 1])
  local existingRaw = redis.call('HGET', key, field)
  local merged = {}
  local seen = {}
  if existingRaw ~= false then
    local ok, existing = pcall(cjson.decode, existingRaw)
    if ok and type(existing) == 'table' then
      for _, v in ipairs(existing) do
        if not seen[v] then seen[v] = true; merged[#merged+1] = v end
      end
    end
  end
  for _, v in ipairs(incoming) do
    if not seen[v] then seen[v] = true; merged[#merged+1] = v end
  end
  redis.call('HSET', key, field, cjson.encode(merged))
end
return 1
`;

/** The JS scalar type-tag stored in a property type-set (P1: types not values). */
export function scalarTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value) ? 'int' : 'float';
  return t; // string | boolean | object | undefined
}

@Injectable()
export class HotBucketWriter {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** `cnt` hash: HINCRBY the per-name day count by 1 (class M). */
  async incrementCount(gameId: string, utcDay: string, bucketName: string): Promise<void> {
    await this.redis.hincrby(IngestKeys.cnt(gameId, utcDay), bucketName, 1);
  }

  /** `rank` zset: ZINCRBY the per-name display rank by 1 (never flushed). */
  async incrementRank(gameId: string, utcDay: string, bucketName: string): Promise<void> {
    await this.redis.zincrby(IngestKeys.cntRank(gameId, utcDay), 1, bucketName);
  }

  /**
   * `cat` mixed hash: one atomic count++/first_seen-min/last_seen-max/pts-union.
   * `props` supplies the observed property KEYS (values are never stored — only
   * their scalar type is unioned into the type-set, P1).
   */
  async upsertCatalog(params: {
    gameId: string;
    bucketName: string;
    kind: EventKind;
    observedTimeMs: number;
    props: Record<string, unknown>;
    propertyKeyCap: number;
  }): Promise<void> {
    const catKey = IngestKeys.cat(params.gameId, params.bucketName);
    // Property-key cap: excess NEW keys ignored (ignore-excess, not other-overflow)
    // — R3 reserves overflow for cardinality caps; the per-event key cap stays
    // ignore-excess with no rollup grain. Deterministic order so the same event
    // keeps the same first `cap` keys.
    const keys = Object.keys(params.props).sort().slice(0, Math.max(0, params.propertyKeyCap));
    const ptsArgs: string[] = [];
    for (const propKey of keys) {
      ptsArgs.push(`${CAT_PTS_PREFIX}${propKey}`, JSON.stringify([scalarTypeOf(params.props[propKey])]));
    }
    await this.redis.eval(
      CAT_MERGE_LUA,
      1,
      catKey,
      String(params.observedTimeMs),
      params.gameId,
      params.bucketName,
      params.kind,
      String(keys.length),
      ...ptsArgs,
    );
  }
}
