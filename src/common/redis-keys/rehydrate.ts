import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.constants';

/**
 * The reserved hash field that marks a bucket as fully rehydrated. Written
 * atomically as the LAST step of a rehydrate block; the flusher SKIPS any dirty
 * bucket lacking it (foundation §2.3, ST2). Reserved — no cell may use this
 * field name.
 */
export const SEEDED_MARKER_FIELD = '__seeded';

/**
 * The durable Postgres floor to seed a missing open-day bucket FROM (§2.3).
 * Never seed from 0 blindly — seed from the last durable absolute so a
 * post-crash flush cannot clobber durable results with near-zero values.
 *
 *  - `fields`  : hash cell → absolute value floor (seeded via HSETNX, per field).
 *  - `members` : set members to union in (seeded via SADD, union-idempotent).
 */
export interface DurableFloor {
  /** Hash field → durable absolute value (string form, bigint-safe). */
  fields?: Record<string, string | number>;
  /** Set members to seed (for `act`/`payer`-style membership buckets). */
  members?: string[];
}

/**
 * Rehydrate-on-miss + seeded-marker machinery (foundation §2.3, P10).
 *
 * The reusable half of the hot-path: given a bucket key and its durable floor,
 * seed the bucket idempotently and mark it `seeded` LAST — so that the flusher
 * can safely skip half-seeded buckets and so two concurrent rehydrators never
 * clobber each other's increments. The per-event INCREMENT itself lives in the
 * worker step (Unit 3); this class only provides seeding + the seeded check +
 * the flush skip-guard.
 */
@Injectable()
export class RehydrateService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Seed a missing (or partially-populated) open-day bucket from its durable
   * floor, then write the `seeded` marker atomically as the last step.
   *
   * Idempotent and race-safe:
   *  - hash fields seed with **HSETNX** (set-if-absent) — a concurrent
   *    rehydrator's already-applied HINCRBY is never overwritten; both
   *    increments land on the single first-wins seed (closes ST1);
   *  - set members seed with **SADD** (union-idempotent — double-seed harmless);
   *  - the `seeded` marker is HSET last, inside one MULTI/EXEC, so a reader
   *    never observes the marker before every seed (closes ST2).
   *
   * Calling on an already-seeded bucket is a no-op (all HSETNX/SADD/marker
   * writes are absorbed).
   */
  async seedBucket(bucketKey: string, floor: DurableFloor): Promise<void> {
    const pipeline = this.redis.multi();

    for (const [field, value] of Object.entries(floor.fields ?? {})) {
      // HSETNX: first seed wins; a live HINCRBY value is never clobbered.
      pipeline.hsetnx(bucketKey, field, String(value));
    }

    if (floor.members && floor.members.length > 0) {
      // SADD is union-idempotent — safe to re-seed.
      pipeline.sadd(bucketKey, ...floor.members);
    }

    // Marker written LAST, in the same atomic transaction as the seeds.
    pipeline.hset(bucketKey, SEEDED_MARKER_FIELD, '1');

    await pipeline.exec();
  }

  /**
   * Is this bucket fully seeded? The flusher calls this and SKIPS any dirty
   * bucket that returns false, retrying it next sweep (primary half-seed guard).
   */
  async isSeeded(bucketKey: string): Promise<boolean> {
    const marker = await this.redis.hget(bucketKey, SEEDED_MARKER_FIELD);
    return marker !== null;
  }

  /**
   * Seed the bucket only if it is not already marked seeded. Returns true if
   * this call performed the seed, false if it was already seeded. A convenience
   * wrapper around {@link isSeeded} + {@link seedBucket}; the underlying writes
   * are idempotent regardless of the check's outcome.
   */
  async seedIfMissing(bucketKey: string, floor: DurableFloor): Promise<boolean> {
    if (await this.isSeeded(bucketKey)) {
      return false;
    }
    await this.seedBucket(bucketKey, floor);
    return true;
  }
}
