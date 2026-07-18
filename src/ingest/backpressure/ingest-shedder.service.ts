/**
 * Ingest shedder (T-00.66–69, T-01.20) — the body behind the door's `maybeShed`
 * seam. Runs the two backpressure brakes in order, BEFORE any enqueue or ack
 * (P11 / DARK-SPOT #6: shedding happens strictly before ack, never after):
 *
 *   1. GLOBAL memory watermark / queue depth → 503 + Retry-After (batch NOT
 *      enqueued, NOT acked, NO raw append, NO Postgres touch). O(1).
 *   2. PER-GAME token-bucket rate cap → whole-batch 429 + Retry-After; refused
 *      batch increments the `rate_limited` tally on the ARRIVAL day; NO raw
 *      append, NO Postgres touch on the check path. O(1).
 *
 * Order matters: the global brake is cheapest and protects the shared budget, so
 * it is checked first. Both throw a NestJS HttpException with a Retry-After
 * header before control returns to the controller, so the controller's enqueue +
 * ack lines are never reached for a shed batch.
 *
 * The `rate_limited` tally is the ONLY write this path performs, and it is a
 * Redis HINCRBY on the arrival-day exc bucket (same class-M path every tally
 * uses) — never a Postgres write on the request path (FR-006).
 */

import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MemoryWatermarkService } from './memory-watermark.service';
import { RateLimitService } from './rate-limit.service';
import { ExceptionTallyWriter } from '../../workers/kernel/exception-tally.writer';
import { arrivalBucketDay } from '../../common/kernel/logical-day';

@Injectable()
export class IngestShedder {
  private readonly logger = new Logger(IngestShedder.name);
  private readonly retryAfterSeconds: number;
  private readonly reportingOffsetMinutes: number;

  constructor(
    private readonly watermark: MemoryWatermarkService,
    private readonly rateLimit: RateLimitService,
    private readonly tally: ExceptionTallyWriter,
    config: ConfigService,
  ) {
    this.retryAfterSeconds = config.get<number>('RETRY_AFTER_SECONDS') ?? 5;
    this.reportingOffsetMinutes = config.get<number>('REPORTING_OFFSET') ?? 0;
  }

  /**
   * Throw a 503 (global watermark) or 429 (per-game cap) if the batch must be
   * shed. Returns normally iff the batch may proceed to enqueue + ack. Called
   * BEFORE the controller enqueues — nothing acked is ever dropped.
   */
  async assertAdmissible(gameId: string, eventCount: number): Promise<void> {
    // ---- 1. Global memory watermark / queue depth → 503 before ack ---------
    const verdict = await this.watermark.evaluate();
    if (verdict.shed) {
      this.logger.warn(
        `[shed] 503 game=${gameId} reason=${verdict.reason ?? 'unknown'} used=${verdict.usedMemory ?? '?'} depth=${verdict.queueDepth ?? '?'}`,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          error: 'Service Unavailable',
          message: 'Ingest temporarily overloaded; retry after the indicated delay.',
          reason: verdict.reason,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
        { cause: verdict.reason },
      );
    }

    // ---- 2. Per-game rate cap → whole-batch 429 + rate_limited tally -------
    const rl = await this.rateLimit.tryAdmitBatch(gameId, eventCount);
    if (!rl.admitted) {
      // rate_limited tally on the ARRIVAL day (server-received day) — a Redis
      // HINCRBY, NOT a Postgres write. The whole refused batch counts ONCE (it is
      // one admit-or-refuse decision), so the tally increments by 1 per refused
      // batch, matching how the batch is refused atomically.
      await this.safeTally(gameId);
      this.logger.warn(`[shed] 429 game=${gameId} cap=${rl.rate}ev/s events=${eventCount}`);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: 'Per-game ingest rate cap exceeded; retry after the indicated delay.',
          reason: 'rate_limited',
        },
        HttpStatus.TOO_MANY_REQUESTS,
        { cause: 'rate_limited' },
      );
    }
  }

  /** The Retry-After header value (seconds) the door sets on a 503/429. */
  get retryAfter(): number {
    return this.retryAfterSeconds;
  }

  /**
   * Increment the arrival-day `rate_limited` tally. Never let a tally-write
   * failure mask the 429 (the batch is still refused); log and swallow.
   */
  private async safeTally(gameId: string): Promise<void> {
    try {
      const arrivalDay = arrivalBucketDay(Date.now(), this.reportingOffsetMinutes);
      await this.tally.tally(gameId, arrivalDay, 'rate_limited');
    } catch (err) {
      this.logger.error(`[shed] rate_limited tally failed for ${gameId} (429 still returned): ${String(err)}`);
    }
  }
}
