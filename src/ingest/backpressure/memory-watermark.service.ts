/**
 * Memory-watermark backpressure (T-00.67, ops-envelope §4).
 *
 * The GLOBAL brake in front of the fast-ack door: past the Redis used-memory
 * watermark (default 80 % of `maxmemory` ≈ 3 GB) OR the queue-depth soft limit
 * (~200k jobs), the ingest API returns 503 + Retry-After BEFORE acking — never
 * shed after ack (P11, DARK-SPOT #6). `noeviction` OOM is indiscriminate; the
 * watermark keeps the counting path alive while the door sheds load.
 *
 * The check is intentionally CHEAP and NON-BLOCKING on Postgres:
 *  - reads `INFO memory` used_memory from Redis (O(1) server-side),
 *  - reads BullMQ waiting+delayed depth,
 * both cached for a short interval so a burst of POSTs does not hammer Redis
 * with INFO calls. If Redis is fully unreachable the check FAILS CLOSED (503) —
 * the door cannot enqueue anyway, so refusing is correct (nothing acked, no loss).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { INGEST_QUEUE_PROVIDER } from '../../queue/queue.constants';

/** The reason the door shed a batch (surfaced in the 503 body / logs). */
export type ShedReason = 'memory_watermark' | 'queue_depth' | 'redis_unreachable';

export interface WatermarkVerdict {
  /** True ⇒ the door must 503 before ack. */
  shed: boolean;
  reason?: ShedReason;
  /** Diagnostic: observed used_memory bytes (undefined if unreadable). */
  usedMemory?: number;
  /** Diagnostic: observed queue depth (undefined if unreadable). */
  queueDepth?: number;
}

/** How long a watermark reading is reused before re-probing Redis (ms). */
const PROBE_CACHE_MS = 250;

@Injectable()
export class MemoryWatermarkService {
  private readonly logger = new Logger(MemoryWatermarkService.name);
  private readonly maxMemoryBytes: number;
  private readonly watermarkFraction: number;
  private readonly queueDepthWatermark: number;
  private cached?: { verdict: WatermarkVerdict; at: number };

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(INGEST_QUEUE_PROVIDER) private readonly queue: Queue,
    config: ConfigService,
  ) {
    this.maxMemoryBytes = config.get<number>('REDIS_MAXMEMORY_BYTES') ?? 3800 * 1024 * 1024;
    this.watermarkFraction = config.get<number>('MEMORY_WATERMARK_FRACTION') ?? 0.8;
    this.queueDepthWatermark = config.get<number>('QUEUE_DEPTH_WATERMARK') ?? 200_000;
  }

  /** The absolute used-memory byte threshold the door brakes at. */
  get watermarkBytes(): number {
    return Math.floor(this.maxMemoryBytes * this.watermarkFraction);
  }

  /**
   * O(1) backpressure check (cached ~250ms). Never touches Postgres. Returns
   * whether the door must 503 and why. Fails CLOSED on an unreachable Redis.
   */
  async evaluate(): Promise<WatermarkVerdict> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < PROBE_CACHE_MS) {
      return this.cached.verdict;
    }
    const verdict = await this.probe();
    this.cached = { verdict, at: now };
    return verdict;
  }

  private async probe(): Promise<WatermarkVerdict> {
    let usedMemory: number | undefined;
    let queueDepth: number | undefined;
    try {
      usedMemory = await this.readUsedMemory();
    } catch (err) {
      // Redis unreachable → cannot enqueue → shed (fail closed). No loss:
      // nothing is acked, the SDK retains + retries.
      this.logger.warn(`[backpressure] Redis INFO failed, failing closed: ${String(err)}`);
      return { shed: true, reason: 'redis_unreachable' };
    }

    if (usedMemory !== undefined && usedMemory >= this.watermarkBytes) {
      return { shed: true, reason: 'memory_watermark', usedMemory };
    }

    try {
      queueDepth = await this.readQueueDepth();
    } catch (err) {
      // Queue depth is a secondary signal; a failure to read it should not by
      // itself shed if memory is healthy. Log and continue (memory already OK).
      this.logger.warn(`[backpressure] queue depth read failed (ignored): ${String(err)}`);
      return { shed: false, usedMemory };
    }

    if (queueDepth >= this.queueDepthWatermark) {
      return { shed: true, reason: 'queue_depth', usedMemory, queueDepth };
    }

    return { shed: false, usedMemory, queueDepth };
  }

  /** Parse `used_memory` from Redis `INFO memory`. */
  private async readUsedMemory(): Promise<number | undefined> {
    const info = await this.redis.info('memory');
    const match = /(?:^|\r?\n)used_memory:(\d+)/.exec(info);
    if (!match) {
      return undefined;
    }
    return Number(match[1]);
  }

  /** Waiting + delayed BullMQ jobs = the backlog depth. */
  private async readQueueDepth(): Promise<number> {
    const counts = await this.queue.getJobCounts('waiting', 'delayed', 'active');
    return (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0);
  }
}
