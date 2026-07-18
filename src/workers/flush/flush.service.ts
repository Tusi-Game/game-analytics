/**
 * The flusher (foundation §3.2) — the repeatable Redis→Postgres job that sweeps
 * the per-domain dirty-registry and upserts ABSOLUTE values under the per-class
 * merge rule (§3.2.1). Shared by every story; 002 wires only its own `cnt`,
 * `cnt:exc` (class M) and `cat` (mixed) structures.
 *
 * INVARIANTS (all load-bearing):
 *   - SKIP any dirty bucket whose `seeded` marker is absent (DARK-SPOT #5 /
 *     ST2) — a half-seeded bucket must never be read into a flush. It is left in
 *     the registry (re-marked) and retried next sweep.
 *   - Deltas NEVER flush — the service only ever reads the CURRENT ABSOLUTE cell
 *     value (HGETALL) and upserts it; there is no additive path.
 *   - Every flush is a NO-OP on retry BY CONSTRUCTION — the merge SQL from
 *     flush-merge.ts is idempotent per class, so a duplicated sweep converges.
 *
 * The service exposes both the periodic `flushDomain()` (drains the registry)
 * and the `sealFinalFlush()` hook (the final flush that runs when a day seals,
 * after which the read model stops consulting Redis for that day — §3.2/§3.3).
 *
 * NOTE: the BullMQ repeatable-job REGISTRATION (scheduling this on
 * `flush_interval`) and the per-event step-8 INCREMENT that marks buckets dirty
 * are Unit 3's wiring. This service is the flush BODY those call.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { RehydrateService, SEEDED_MARKER_FIELD } from '../../common/redis-keys/rehydrate';
import { Domain } from '../../common/redis-keys/redis-keys';
import { DirtyRegistry } from './dirty-registry';
import { buildFlushStatement, FlushRow, MergeTableSpec } from './flush-merge';

export type { FlushRow, MergeTableSpec };

/**
 * Translates one Redis bucket key + its (already seeded-verified) hash contents
 * into the set of absolute {@link FlushRow}s to upsert into `spec.table`. Each
 * domain owner supplies this; 002 supplies the `cnt`/`cnt:exc`/`cat` projectors.
 * It receives ONLY absolute values (the current hash state), never deltas.
 */
export type BucketProjector = (bucketKey: string, hash: Record<string, string>) => FlushRow[];

/** One domain's flush plan: its dirty-registry domain, merge spec, projector. */
export interface DomainFlushPlan {
  domain: Domain;
  spec: MergeTableSpec;
  project: BucketProjector;
}

/** Outcome of a domain sweep (observability + test assertions). */
export interface FlushSweepResult {
  /** Buckets drained from the registry this sweep. */
  drained: number;
  /** Buckets flushed (seeded, non-empty). */
  flushed: number;
  /** Buckets SKIPPED because their `seeded` marker was absent (re-queued). */
  skippedUnseeded: number;
  /** Absolute upserts executed. */
  upserts: number;
}

@Injectable()
export class FlushService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly rehydrate: RehydrateService,
    private readonly dirty: DirtyRegistry,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Sweep one domain: drain its dirty-registry, and for each bucket that IS
   * seeded, read its absolute hash and upsert every projected row idempotently.
   * A bucket whose `seeded` marker is absent is SKIPPED and re-marked (ST2).
   */
  async flushDomain(plan: DomainFlushPlan): Promise<FlushSweepResult> {
    const buckets = await this.dirty.drain(plan.domain);
    const result: FlushSweepResult = { drained: buckets.length, flushed: 0, skippedUnseeded: 0, upserts: 0 };

    for (const bucketKey of buckets) {
      // Primary half-seed guard (DARK-SPOT #5): never flush an unseeded bucket.
      if (!(await this.rehydrate.isSeeded(bucketKey))) {
        result.skippedUnseeded += 1;
        // Re-queue so the next sweep retries it once seeding completes.
        await this.dirty.mark(plan.domain, bucketKey);
        continue;
      }

      const upserts = await this.flushBucket(plan, bucketKey);
      result.upserts += upserts;
      result.flushed += 1;
    }

    return result;
  }

  /**
   * Seal-time final flush (§3.2/§3.3): flush the given bucket keys one last time
   * as a day seals, after which the read model reads that day from Postgres
   * only. Same idempotent path — it may safely re-run buckets already flushed
   * this cadence (no-op by construction). Unlike the periodic sweep it flushes
   * the explicit bucket list (the day's cells) rather than draining the
   * registry, and it still honours the seeded-skip guard.
   */
  async sealFinalFlush(plan: DomainFlushPlan, bucketKeys: string[]): Promise<FlushSweepResult> {
    const result: FlushSweepResult = { drained: bucketKeys.length, flushed: 0, skippedUnseeded: 0, upserts: 0 };
    for (const bucketKey of bucketKeys) {
      if (!(await this.rehydrate.isSeeded(bucketKey))) {
        result.skippedUnseeded += 1;
        // A day cannot finalize on an unseeded bucket — leave it dirty so the
        // seal defers (ops-envelope §4: seal defers rather than finalizing short).
        await this.dirty.mark(plan.domain, bucketKey);
        continue;
      }
      result.upserts += await this.flushBucket(plan, bucketKey);
      result.flushed += 1;
    }
    return result;
  }

  /**
   * Read one seeded bucket's ABSOLUTE hash and upsert its projected rows. The
   * reserved `seeded` marker field is stripped before projection so it never
   * leaks into a cell value.
   */
  private async flushBucket(plan: DomainFlushPlan, bucketKey: string): Promise<number> {
    const hash = await this.redis.hgetall(bucketKey);
    // Strip the reserved marker — it is bookkeeping, not a cell.
    delete hash[SEEDED_MARKER_FIELD];

    const rows = plan.project(bucketKey, hash);
    let upserts = 0;
    for (const row of rows) {
      const { sql, params } = buildFlushStatement(plan.spec, row);
      await this.dataSource.query(sql, params);
      upserts += 1;
    }
    return upserts;
  }
}
