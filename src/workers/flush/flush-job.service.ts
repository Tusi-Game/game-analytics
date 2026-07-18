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
 *
 * ============ Stage-C: additive per-domain sweep seam ====================
 * A typed story (003/004/006) introduces its OWN flushed domains (eco/bal/sess/
 * act/ret/mon/payer …). Rather than every story editing {@link sweep} on the same
 * line — a guaranteed merge collision — a story REGISTERS its extra domain flush
 * plans through the {@link EXTRA_DOMAIN_FLUSH_PLANS} multi-provider token. This
 * service drains + flushes each registered plan's domain IN ADDITION to the three
 * 002 domains. Adding a story is therefore purely additive.
 *
 * Registration is a `{ provide: EXTRA_DOMAIN_FLUSH_PLANS, multi: true, useValue:
 * { domain, plan } }` entry in the story module. `domain` is the dirty-registry
 * domain to drain; `plan` is the {@link DomainFlushPlan} to flush the drained
 * keys under. Multiple plans MAY share one `domain` (each is applied to the same
 * drained key batch — exactly how 002's cnt/exc share the `cnt` domain).
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Domain } from '../../common/redis-keys/redis-keys';
import { DirtyRegistry } from './dirty-registry';
import { FlushService, type ClassNFlushPlan, type DomainFlushPlan, type FlushSweepResult } from './flush.service';
import { CAT_FLUSH_PLAN, CNT_FLUSH_PLAN, EXC_FLUSH_PLAN, partitionCntBuckets } from './flush-plans';

/**
 * One story-registered extra sweep step: drain `domain`, flush the drained keys
 * under `plan`. Stories contribute these via {@link EXTRA_DOMAIN_FLUSH_PLANS}.
 * `domain` must be one of the pre-reserved story domains ({@link Domain} —
 * sess/act/eco/bal/ret/mon/payer/rev/stage), so the domain palette itself is
 * already collision-free (foundation §2.1).
 */
export interface ExtraDomainFlushPlan {
  /** The dirty-registry domain to drain (e.g. `eco`, `sess`, `mon`). */
  readonly domain: Domain;
  /** The plan to flush the drained keys under. */
  readonly plan: DomainFlushPlan;
}

/**
 * Multi-provider token for story-registered extra sweep steps. Inject as
 * `ExtraDomainFlushPlan[]`. Absent (no story wired) → the sweep is exactly 002's.
 */
export const EXTRA_DOMAIN_FLUSH_PLANS = 'EXTRA_DOMAIN_FLUSH_PLANS';

/**
 * One story-registered CLASS-N sweep step (006 build gap). Class N cannot use the
 * plain HGETALL-per-hash path — it requires an atomic Lua snapshot of (gen + all
 * related data hashes) so a MOVE's decrement+increment are both-in/both-out. Stories
 * contribute these via {@link EXTRA_CLASS_N_FLUSH_PLANS}; the sweep runs each
 * additively after the M/S/L plans.
 */
export interface ExtraClassNFlushPlan {
  /** The dirty-registry domain to drain. */
  readonly domain: Domain;
  /** The class-N plan to snapshot + flush the drained keys under. */
  readonly plan: ClassNFlushPlan;
}

/**
 * Multi-provider token for story-registered class-N sweep steps. Inject as
 * `ExtraClassNFlushPlan[]`. Absent → the sweep runs no class-N step (byte-for-byte 002).
 */
export const EXTRA_CLASS_N_FLUSH_PLANS = 'EXTRA_CLASS_N_FLUSH_PLANS';

/** Aggregate result of one full sweep across all 002 domains. */
export interface FullSweepResult {
  cnt: FlushSweepResult;
  exc: FlushSweepResult;
  cat: FlushSweepResult;
  /** Per-domain results of any story-registered extra sweep steps (Stage-C). */
  extra?: Record<string, FlushSweepResult>;
  /** Per-domain results of any story-registered class-N sweep steps (006). */
  extraN?: Record<string, FlushSweepResult>;
}

@Injectable()
export class FlushJobService {
  constructor(
    private readonly dirty: DirtyRegistry,
    private readonly flush: FlushService,
    @Optional()
    @Inject(EXTRA_DOMAIN_FLUSH_PLANS)
    private readonly extraPlans: readonly ExtraDomainFlushPlan[] = [],
    @Optional()
    @Inject(EXTRA_CLASS_N_FLUSH_PLANS)
    private readonly extraNPlans: readonly ExtraClassNFlushPlan[] = [],
  ) {}

  /**
   * One periodic sweep: drain `cnt` (day-count + exc) and `cat`, flush each under
   * its plan. Unseeded buckets are re-marked by `sealFinalFlush` and retried next
   * sweep. Idempotent — a duplicated sweep converges (class M / mixed-cat merge).
   *
   * Any story-registered {@link EXTRA_DOMAIN_FLUSH_PLANS} then run additively:
   * each distinct domain is drained ONCE and every plan on that domain is flushed
   * over the same drained batch (mirrors the 002 cnt/exc split).
   */
  async sweep(): Promise<FullSweepResult> {
    // Drain cnt ONCE; split day-count vs exception buckets.
    const cntBuckets = await this.dirty.drain('cnt');
    const { cntKeys, excKeys } = partitionCntBuckets(cntBuckets);
    const catBuckets = await this.dirty.drain('cat');

    const cnt = await this.flush.sealFinalFlush(CNT_FLUSH_PLAN, cntKeys);
    const exc = await this.flush.sealFinalFlush(EXC_FLUSH_PLAN, excKeys);
    const cat = await this.flush.sealFinalFlush(CAT_FLUSH_PLAN, catBuckets);

    const extra = await this.sweepExtraDomains();
    const extraN = await this.sweepClassNDomains();

    const base: FullSweepResult = { cnt, exc, cat };
    if (extra) {
      base.extra = extra;
    }
    if (extraN) {
      base.extraN = extraN;
    }
    return base;
  }

  /**
   * Drain + class-N-flush every story-registered class-N domain. Each distinct domain is
   * drained ONCE; every class-N plan on that domain snapshots + flushes over that batch.
   * Returns undefined when no story registered a class-N plan (keeps the 002 shape).
   */
  private async sweepClassNDomains(): Promise<Record<string, FlushSweepResult> | undefined> {
    if (this.extraNPlans.length === 0) {
      return undefined;
    }
    const byDomain = new Map<Domain, ClassNFlushPlan[]>();
    for (const { domain, plan } of this.extraNPlans) {
      const list = byDomain.get(domain);
      if (list) {
        list.push(plan);
      } else {
        byDomain.set(domain, [plan]);
      }
    }
    const results: Record<string, FlushSweepResult> = {};
    for (const [domain, plans] of byDomain) {
      const keys = await this.dirty.drain(domain);
      for (const plan of plans) {
        results[`${domain}:${plan.spec.table}`] = await this.flush.sealFinalFlushClassN(plan, keys);
      }
    }
    return results;
  }

  /**
   * Drain + flush every story-registered extra domain. Each distinct domain is
   * drained ONCE (even if multiple plans target it), then all its plans are
   * flushed over that single drained batch. Returns undefined when no story has
   * registered any extra plan (keeps {@link FullSweepResult.extra} absent so the
   * 002 result shape is byte-for-byte unchanged).
   */
  private async sweepExtraDomains(): Promise<Record<string, FlushSweepResult> | undefined> {
    if (this.extraPlans.length === 0) {
      return undefined;
    }
    // Group plans by domain so each domain is drained exactly once.
    const byDomain = new Map<Domain, DomainFlushPlan[]>();
    for (const { domain, plan } of this.extraPlans) {
      const list = byDomain.get(domain);
      if (list) {
        list.push(plan);
      } else {
        byDomain.set(domain, [plan]);
      }
    }
    const results: Record<string, FlushSweepResult> = {};
    for (const [domain, plans] of byDomain) {
      const keys = await this.dirty.drain(domain);
      for (const plan of plans) {
        // Result key disambiguates multiple plans on one domain by the plan's
        // target spec identity; last write wins only if two plans truly collide.
        const result = await this.flush.sealFinalFlush(plan, keys);
        results[`${domain}:${plan.spec.table}`] = result;
      }
    }
    return results;
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
