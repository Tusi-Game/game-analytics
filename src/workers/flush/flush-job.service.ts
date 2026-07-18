/**
 * Flush-job orchestration (T-01.15/16, foundation §3.2) — drives the periodic
 * Redis→Postgres sweep and the seal-time final flush over 002's three flushed
 * structures.
 *
 * The `cnt` dirty domain holds BOTH day-count buckets (`{game}:cnt:{day}`) and
 * exception-tally buckets (`{game}:cnt:{day}:exc`). This service drains that
 * domain ONCE, partitions by key shape, and flushes each half under its own plan
 * ({@link CNT_FLUSH_PLAN} → EVENT_DAY_COUNT, {@link EXC_FLUSH_PLAN} →
 * EXCEPTION_TALLY). The `cat` domain flushes under {@link CAT_FLUSH_PLAN}.
 *
 * Reuses {@link FlushService.sealFinalFlush} (explicit bucket list, seeded-skip,
 * idempotent) for both the periodic sweep (over the drained keys) and the
 * seal-time final flush, so there is one flush BODY and it is a no-op on retry by
 * construction. The BullMQ repeatable job REGISTRATION lives in the worker
 * (ingest.worker.ts); this service is the body it invokes.
 */

import { Injectable } from '@nestjs/common';
import { DirtyRegistry } from './dirty-registry';
import { FlushService, type FlushSweepResult } from './flush.service';
import { CAT_FLUSH_PLAN, CNT_FLUSH_PLAN, EXC_FLUSH_PLAN, partitionCntBuckets } from './flush-plans';

/** Aggregate result of one full sweep across all 002 domains. */
export interface FullSweepResult {
  cnt: FlushSweepResult;
  exc: FlushSweepResult;
  cat: FlushSweepResult;
}

@Injectable()
export class FlushJobService {
  constructor(
    private readonly dirty: DirtyRegistry,
    private readonly flush: FlushService,
  ) {}

  /**
   * One periodic sweep: drain `cnt` (day-count + exc) and `cat`, flush each under
   * its plan. Unseeded buckets are re-marked by `sealFinalFlush` and retried next
   * sweep. Idempotent — a duplicated sweep converges (class M / mixed-cat merge).
   */
  async sweep(): Promise<FullSweepResult> {
    // Drain cnt ONCE; split day-count vs exception buckets.
    const cntBuckets = await this.dirty.drain('cnt');
    const { cntKeys, excKeys } = partitionCntBuckets(cntBuckets);
    const catBuckets = await this.dirty.drain('cat');

    const cnt = await this.flush.sealFinalFlush(CNT_FLUSH_PLAN, cntKeys);
    const exc = await this.flush.sealFinalFlush(EXC_FLUSH_PLAN, excKeys);
    const cat = await this.flush.sealFinalFlush(CAT_FLUSH_PLAN, catBuckets);

    return { cnt, exc, cat };
  }

  /**
   * Seal-time final flush for a specific day's buckets (§3.2/§3.3): after this,
   * the read model reads that day from Postgres only. `cat` is day-less (flushed
   * by the periodic sweep) so only the day-scoped `cnt`/`cnt:exc` buckets are
   * finalized here. Same idempotent body.
   */
  async sealFinalFlush(
    cntBucketKeys: string[],
    excBucketKeys: string[],
  ): Promise<{ cnt: FlushSweepResult; exc: FlushSweepResult }> {
    const cnt = await this.flush.sealFinalFlush(CNT_FLUSH_PLAN, cntBucketKeys);
    const exc = await this.flush.sealFinalFlush(EXC_FLUSH_PLAN, excBucketKeys);
    return { cnt, exc };
  }
}
