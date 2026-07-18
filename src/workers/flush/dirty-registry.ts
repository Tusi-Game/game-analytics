/**
 * Dirty-registry (foundation §3.2) — the small per-domain set of open-day bucket
 * keys that have been touched since the last flush. The flusher DRAINS it each
 * sweep; a bucket not in the registry is skipped (nothing changed).
 *
 * Backed by a Redis SET per (domain) so worker step-8 (Unit 3) can `mark()` a
 * bucket as dirty in the same hot path that increments it, and the flush job can
 * atomically snapshot-and-clear the set. `drain()` uses RENAME so the sweep sees
 * a stable snapshot while new marks accumulate in a fresh set — no bucket touched
 * mid-sweep is lost (it lands in the next set and is picked up next sweep).
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { Domain } from '../../common/redis-keys/redis-keys';

/** The registry key holding the live dirty set for a domain. */
function registryKey(domain: Domain): string {
  return `ops:dirty:${domain}`;
}

/** A transient snapshot key the drain renames the live set to. */
function snapshotKey(domain: Domain): string {
  return `ops:dirty:${domain}:draining`;
}

/**
 * Atomic snapshot-and-clear (foundation §3.2). Runs the whole drain server-side
 * so two concurrent drains of the SAME domain (multiple flush workers, or a
 * shared-Redis test harness) can never race a check-then-act:
 *
 *   KEYS[1] = live registry set, KEYS[2] = transient snapshot set.
 *
 * A previous `EXISTS live` → `RENAME live snap` sequence had a TOCTOU hole: a
 * second drainer could RENAME `live` away between the two commands, so the first
 * RENAME hit a missing key and threw `ERR no such key`. Doing it in one Lua body
 * closes that window (Redis executes a script atomically). Steps:
 *   1. fold any leftover snapshot (a prior crashed drain) back into `live`;
 *   2. if `live` is empty/absent → return {} (nothing to flush);
 *   3. RENAME live→snap, read members, DEL snap, return the members.
 * Marks made AFTER the rename accumulate in a fresh `live` and drain next sweep.
 */
const DRAIN_LUA = `
local live = KEYS[1]
local snap = KEYS[2]
-- Recover a stranded snapshot from a prior crashed drain (idempotent).
if redis.call('EXISTS', snap) == 1 then
  local leftover = redis.call('SMEMBERS', snap)
  if #leftover > 0 then
    redis.call('SADD', live, unpack(leftover))
  end
  redis.call('DEL', snap)
end
-- Empty/absent live set → nothing to drain this sweep.
if redis.call('EXISTS', live) == 0 then
  return {}
end
redis.call('RENAME', live, snap)
local members = redis.call('SMEMBERS', snap)
redis.call('DEL', snap)
return members
`;

@Injectable()
export class DirtyRegistry {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Mark a bucket key dirty for `domain`. Called by worker step-8 right after a
   * hot increment, so every touched open-day bucket is queued for flush. SADD is
   * idempotent — marking the same bucket twice in a window is one entry.
   */
  async mark(domain: Domain, bucketKey: string): Promise<void> {
    await this.redis.sadd(registryKey(domain), bucketKey);
  }

  /**
   * Atomically snapshot-and-clear the dirty set for `domain`, returning the
   * bucket keys to flush this sweep. Implemented as RENAME live→snapshot so:
   *   - the sweep reads a stable, complete snapshot;
   *   - concurrent `mark()`s during the sweep create a fresh live set and are
   *     picked up on the NEXT sweep (never lost);
   *   - an empty registry renames nothing and returns [].
   * The snapshot key is consumed (SMEMBERS + DEL) after reading.
   */
  async drain(domain: Domain): Promise<string[]> {
    const live = registryKey(domain);
    const snap = snapshotKey(domain);
    // Atomic snapshot-and-clear (see DRAIN_LUA) — no check-then-act RENAME race.
    const members = (await this.redis.eval(DRAIN_LUA, 2, live, snap)) as string[];
    return members;
  }

  /** Peek the current dirty count (observability / tests) without draining. */
  async size(domain: Domain): Promise<number> {
    return this.redis.scard(registryKey(domain));
  }
}
