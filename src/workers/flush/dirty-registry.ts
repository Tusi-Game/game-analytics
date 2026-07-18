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

    // RENAME throws if the source is missing (empty registry) — treat as empty.
    const exists = await this.redis.exists(live);
    if (exists === 0) {
      return [];
    }

    // If a prior drain crashed after RENAME but before consuming the snapshot,
    // fold those stragglers back in so nothing is stranded.
    const leftover = await this.redis.smembers(snap);
    if (leftover.length > 0) {
      await this.redis.sadd(live, ...leftover);
      await this.redis.del(snap);
    }

    await this.redis.rename(live, snap);
    const members = await this.redis.smembers(snap);
    await this.redis.del(snap);
    return members;
  }

  /** Peek the current dirty count (observability / tests) without draining. */
  async size(domain: Domain): Promise<number> {
    return this.redis.scard(registryKey(domain));
  }
}
