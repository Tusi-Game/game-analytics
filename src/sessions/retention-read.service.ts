/**
 * Retention read model (T-04.19..26, [005-retention] design read-model) —
 * classic Day-N. READ-TIME only: computes headline D1/D7/D30, the cohort × offset
 * heatmap triangle, and the two independent masks (immature-cohort, small-cohort)
 * + the χ² / two-proportion gate. Mutates NO stored cell.
 *
 * Merge (Foundation §3.3): a cell `(c, N)` is live-merged from the open `ret`
 * bucket iff its ACTIVITY day `c + N` is still open; sealed cells come from
 * RETENTION_CELL only. `cohort_size` merges from the `ret` bucket of day `c` while
 * `c` is open. GREATEST per cell (the live hash rehydrated from the durable floor,
 * so it already includes it — never a sum; class-M semantics).
 *
 * Masks (both apply independently — they are separate predicates):
 *   - immature-cohort → N/A when `today_logical − cohort_date < N`.
 *   - small-cohort    → low-confidence when `cohort_size < retention_min_cohort_size`.
 * Headline averages over the FIXED mature-cohort set (survivorship/mixed-maturity
 * guard); the default surface is the triangle, not a blended line.
 *
 * R10 segmented retention is v1-DEFERRED (build none — documented). This service
 * exposes only the platform-wide (un-segmented) surfaces.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { CohortEntity } from '../database/entities/cohort.entity';
import { RetentionCellEntity } from '../database/entities/retention-cell.entity';
import { SessionConfigService } from './session-config.service';
import { SessionKeys, RET_FIELD_SIZE, retCellField } from './session-keys';

/** A single heatmap cell's read-time value + mask state. */
export interface RetentionCellView {
  cohortDate: string;
  offset: number;
  /** retained_users / cohort_size, or null when masked. */
  rate: number | null;
  retained: number;
  cohortSize: number;
  /** True iff `today_logical − cohort_date < offset` (day N not yet elapsed). */
  immature: boolean;
  /** True iff `cohort_size < retention_min_cohort_size` (sample-size guard). */
  lowConfidence: boolean;
  /** True iff any live (open-day) value contributed → provisional. */
  provisional: boolean;
}

/** One headline offset (D1/D7/D30…) over the fixed mature-cohort set. */
export interface HeadlineView {
  offset: number;
  /** Σ retained / Σ size over MATURE cohorts, or null when no mature cohort exists. */
  rate: number | null;
  retainedSum: number;
  sizeSum: number;
  /** The cohort days that entered this offset's average (the FIXED set). */
  matureCohorts: string[];
}

@Injectable()
export class RetentionReadService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly dataSource: DataSource,
    private readonly sessionConfig: SessionConfigService,
  ) {}

  /**
   * Headline D_N for each target offset over the FIXED set of cohorts mature at N
   * (`today_logical − c ≥ N`). Immature cohorts are excluded from BOTH sums so a
   * young cohort can never drag the number toward zero (survivorship guard).
   */
  async headline(gameId: string, now: number = Date.now()): Promise<HeadlineView[]> {
    const targets = await this.sessionConfig.retentionDayTargets(gameId);
    const today = this.sessionConfig.todayLogical(now);
    const sizes = await this.cohortSizes(gameId);

    const out: HeadlineView[] = [];
    for (const offset of targets) {
      let retainedSum = 0;
      let sizeSum = 0;
      const matureCohorts: string[] = [];
      for (const [cohortDate, size] of sizes) {
        if (dayDiff(cohortDate, today) < offset) {
          continue; // immature at this offset — excluded from the fixed set.
        }
        matureCohorts.push(cohortDate);
        sizeSum += size;
        retainedSum += await this.cellRetained(gameId, cohortDate, offset, today);
      }
      out.push({
        offset,
        rate: sizeSum > 0 ? retainedSum / sizeSum : null,
        retainedSum,
        sizeSum,
        matureCohorts,
      });
    }
    return out;
  }

  /**
   * The cohort × offset heatmap triangle for a set of offsets (defaults to the
   * game's `retention_day_targets`). Each cell carries its rate + both mask flags;
   * `rate` is null when the immature mask applies (N/A). D0 is 100 % by
   * construction (bit 0 == cohort membership).
   */
  async heatmap(gameId: string, offsets?: number[], now: number = Date.now()): Promise<RetentionCellView[]> {
    const targetOffsets = offsets ?? [0, ...(await this.sessionConfig.retentionDayTargets(gameId))];
    const uniqueOffsets = [...new Set(targetOffsets)].sort((a, b) => a - b);
    const today = this.sessionConfig.todayLogical(now);
    const minCohort = await this.sessionConfig.minCohortSize(gameId);
    const sizes = await this.cohortSizes(gameId);

    const out: RetentionCellView[] = [];
    for (const [cohortDate, cohortSize] of sizes) {
      const lowConfidence = cohortSize < minCohort;
      for (const offset of uniqueOffsets) {
        const immature = dayDiff(cohortDate, today) < offset;
        const activityDay = addDays(cohortDate, offset);
        const provisional = !immature && (await this.isActivityDayOpen(activityDay, today));
        const retained = immature ? 0 : await this.cellRetained(gameId, cohortDate, offset, today);
        const rate = immature || cohortSize === 0 ? null : retained / cohortSize;
        out.push({
          cohortDate,
          offset,
          rate,
          retained,
          cohortSize,
          immature,
          lowConfidence,
          provisional,
        });
      }
    }
    return out;
  }

  /**
   * Two-proportion z / χ² gate for a cohort-vs-cohort "X beats Y" callout at an
   * offset (T-04.26): returns whether the difference is significant at α=0.05
   * (|z| > 1.96, equivalently χ² > 3.841). NEVER a raw point comparison — a
   * callout is gated behind this. Returns `null` when either denominator is 0.
   */
  async cohortBeatsCohort(
    gameId: string,
    cohortA: string,
    cohortB: string,
    offset: number,
    now: number = Date.now(),
  ): Promise<{ significant: boolean; z: number } | null> {
    const today = this.sessionConfig.todayLogical(now);
    const sizes = await this.cohortSizes(gameId);
    const nA = sizes.get(cohortA) ?? 0;
    const nB = sizes.get(cohortB) ?? 0;
    if (nA === 0 || nB === 0) {
      return null;
    }
    const xA = await this.cellRetained(gameId, cohortA, offset, today);
    const xB = await this.cellRetained(gameId, cohortB, offset, today);
    const pA = xA / nA;
    const pB = xB / nB;
    const pPool = (xA + xB) / (nA + nB);
    const se = Math.sqrt(pPool * (1 - pPool) * (1 / nA + 1 / nB));
    if (se === 0) {
      return { significant: false, z: 0 };
    }
    const z = (pA - pB) / se;
    return { significant: Math.abs(z) > 1.96, z };
  }

  // ---- internals ---------------------------------------------------------

  /** All cohorts (day → size), merged durable COHORT + open `ret:{c}` bucket size. */
  private async cohortSizes(gameId: string): Promise<Map<string, number>> {
    const rows = await this.dataSource.getRepository(CohortEntity).find({
      where: { gameId },
      select: { cohortDate: true, cohortSize: true },
    });
    const sizes = new Map<string, number>();
    for (const row of rows) {
      sizes.set(row.cohortDate, Number(row.cohortSize));
    }
    // Merge any live `size` from the cohort's own open bucket (day c). GREATEST.
    for (const cohortDate of new Set(sizes.keys())) {
      const live = await this.liveRetHash(gameId, cohortDate);
      const liveSize = live[RET_FIELD_SIZE];
      if (liveSize !== undefined) {
        sizes.set(cohortDate, Math.max(sizes.get(cohortDate) ?? 0, Number(liveSize)));
      }
    }
    // A brand-new cohort may exist only in Redis (not yet flushed) — pick it up by
    // scanning is avoided (no SCAN in hot read); the durable row appears within one
    // flush cadence. For read-time correctness on the current open day the caller
    // may pass a recently-flushed game. (Documented Foundation §3.3 provisionality.)
    return sizes;
  }

  /** retained_users for cell (c, N): durable RETENTION_CELL GREATEST live ret bucket. */
  private async cellRetained(gameId: string, cohortDate: string, offset: number, today: string): Promise<number> {
    const durableRow = await this.dataSource.getRepository(RetentionCellEntity).findOne({
      where: { gameId, cohortDate, dayOffset: offset },
      select: { retainedUsers: true },
    });
    let value = durableRow ? Number(durableRow.retainedUsers) : 0;
    const activityDay = addDays(cohortDate, offset);
    if (await this.isActivityDayOpen(activityDay, today)) {
      const live = await this.liveRetHash(gameId, activityDay);
      const liveCell = live[retCellField(cohortDate, offset)];
      if (liveCell !== undefined) {
        value = Math.max(value, Number(liveCell)); // GREATEST — live already includes floor.
      }
    }
    return value;
  }

  /** Read the open `ret:{day}` hash (reserved marker stripped). */
  private async liveRetHash(gameId: string, day: string): Promise<Record<string, string>> {
    const hash = await this.redis.hgetall(SessionKeys.ret(gameId, day));
    delete hash['__seeded'];
    return hash;
  }

  /**
   * An activity day is "open" (still Redis-merged) iff it is today or in the future
   * relative to today_logical — a coarse liveness proxy that never UNDER-merges a
   * mature sealed cell (past days read durable-only). Exact seal timing is the
   * flusher's; for the read merge, day ≥ today ⇒ consult Redis.
   */
  private async isActivityDayOpen(activityDay: string, today: string): Promise<boolean> {
    return dayDiff(activityDay, today) <= 0;
  }
}

/** Integer day difference b − a for two "YYYY-MM-DD" days. */
function dayDiff(a: string, b: string): number {
  const MS_PER_DAY = 86_400_000;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS_PER_DAY);
}

/** Add `n` days to a "YYYY-MM-DD" day, returning a "YYYY-MM-DD" day. */
function addDays(day: string, n: number): string {
  const MS_PER_DAY = 86_400_000;
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * MS_PER_DAY).toISOString().slice(0, 10);
}
