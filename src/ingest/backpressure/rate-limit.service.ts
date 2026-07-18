/**
 * Per-game rate limiting — `ingest_events_per_sec_cap` token bucket (T-00.69,
 * ops-envelope §5).
 *
 * The PER-TENANT brake that trips before the global §4 watermark: one flooding
 * game (a bug, a hostile client on the public sdk_key) consumes its OWN cap
 * instead of the platform's. Counted in EVENTS (batch size varies; events are
 * the cost driver).
 *
 * WHOLE-BATCH ATOMIC admit-or-refuse (never partial): a single Lua EVAL reads
 * the bucket, refills by elapsed time, and either debits the whole batch's event
 * count (admit) or leaves the bucket untouched (refuse). Because the read +
 * refill + debit are one atomic script, two concurrent batches cannot both
 * over-draw. O(1), NO Postgres touch on the check path (FR-006) — a well-behaved
 * game never observes it.
 *
 * On refuse the caller 429s the WHOLE batch + Retry-After and tallies
 * `rate_limited` on the ARRIVAL day. Refused batches are NEVER raw-appended
 * (flow control, not a verdict) — the SDK retains + retries, so nothing
 * countable is lost (SC-008 unaffected).
 */

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { OpsKeys } from '../../common/redis-keys/redis-keys';
import { GameConfigService } from '../../config/game-config.service';

/**
 * Atomic token-bucket script. KEYS[1] = bucket hash. ARGV:
 *   1 rate (tokens/sec), 2 burst (max tokens), 3 cost (events this batch),
 *   4 now_ms, 5 ttl_seconds.
 * Fields: `tokens` (float), `ts` (last-refill epoch ms).
 * Returns 1 if admitted (debited), 0 if refused (untouched).
 *
 * On first touch the bucket seeds FULL (burst) so a fresh game is not
 * immediately throttled. Refill = elapsed_seconds × rate, capped at burst.
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil or ts == nil then
  tokens = burst
  ts = now
end

local elapsed = (now - ts) / 1000.0
if elapsed < 0 then elapsed = 0 end
tokens = math.min(burst, tokens + elapsed * rate)

local admitted = 0
if tokens >= cost then
  tokens = tokens - cost
  admitted = 1
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, ttl)
return admitted
`;

export interface RateLimitVerdict {
  /** True ⇒ the whole batch is admitted; false ⇒ 429 the whole batch. */
  admitted: boolean;
  /** The effective per-game cap used (events/sec) — diagnostic. */
  rate: number;
}

@Injectable()
export class RateLimitService {
  private readonly defaultRate: number;
  private readonly burst: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService,
    private readonly gameConfig: GameConfigService,
  ) {
    this.defaultRate = config.get<number>('INGEST_EVENTS_PER_SEC_CAP') ?? 200;
    this.burst = config.get<number>('INGEST_RATE_BURST_EVENTS') ?? 5000;
  }

  /**
   * Atomically try to admit a whole batch of `eventCount` events for a game.
   * Per-game `ingest_events_per_sec_cap` override wins over the platform default
   * (forward-only, read from GAME.config). NO Postgres on the hot path beyond the
   * short-cached config read.
   *
   * A cap of 0 (or negative) means "unlimited" — admit everything (the check is
   * a no-op) so a game can opt out; the default is the platform cap.
   */
  async tryAdmitBatch(gameId: string, eventCount: number): Promise<RateLimitVerdict> {
    const override = await this.gameConfig.getNumber(gameId, 'ingest_events_per_sec_cap');
    const rate = override ?? this.defaultRate;

    // Unlimited opt-out, or a degenerate empty batch → always admit.
    if (rate <= 0 || eventCount <= 0) {
      return { admitted: true, rate };
    }
    // A single batch larger than the entire burst can never be admitted by a
    // full bucket; admit it anyway (it is one legitimate offline flush) rather
    // than wedge the client forever. Burst is the steady-state guard, not a hard
    // per-batch ceiling.
    const cost = Math.min(eventCount, this.burst);

    const key = OpsKeys.rateLimit(gameId);
    // Bucket TTL: enough to hold state across a burst window; idle games expire.
    const ttlSeconds = Math.max(60, Math.ceil(this.burst / Math.max(rate, 1)) + 60);

    const result = (await this.redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      key,
      String(rate),
      String(this.burst),
      String(cost),
      String(Date.now()),
      String(ttlSeconds),
    )) as number;

    return { admitted: result === 1, rate };
  }
}
