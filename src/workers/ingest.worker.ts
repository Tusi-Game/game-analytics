/**
 * BullMQ ingest worker (T-01.21–31) — realizes the op-order kernel end-to-end.
 *
 * Registers a single {@link Worker} on `ingest-queue` (using
 * INGEST_WORKER_CONNECTION) and, for each event in a dequeued batch, runs
 * {@link IngestKernel.process} (steps 1→9). Drops/quarantines increment
 * EXCEPTION_TALLY on the ARRIVAL day. Records in a batch are processed
 * CONCURRENTLY so their write-ahead raw appends coalesce into ONE group-commit
 * fsync per dequeued batch (bridge 01.5 §4 fsync grain) while each record's
 * counter still blocks on that fsync (fsync-before-count, DARK-SPOT #3).
 *
 * At-least-once + job_id threading: BullMQ acks the JOB when this processor
 * RETURNS. A crash between step 6 and return → the retried job re-runs; every
 * already-counted record is a windowed/durable dedup no-op → bounded undercount,
 * never a double-count (T-01.29). Workers NEVER crash on malformed input — every
 * per-event failure is an isolated verdict (T-01.31), so one bad event never
 * fails its batch's siblings.
 *
 * Also registers the FLUSH repeatable job (drains the dirty registry via
 * {@link FlushJobService}) on `flush_interval_seconds`.
 */

import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { INGEST_QUEUE, INGEST_QUEUE_PROVIDER, INGEST_WORKER_CONNECTION } from '../queue/queue.constants';
import type { EventEnvelope } from '../common/contracts/envelope';
import type { IngestBatchJob } from '../common/contracts/queue-jobs';
import { arrivalBucketDay } from '../common/kernel/logical-day';
import { IngestKernel, type KernelContext, type PipelineOutcome } from './kernel/ingest-kernel';
import { ExceptionTallyWriter } from './kernel/exception-tally.writer';
import { FlushJobService } from './flush/flush-job.service';

/** BullMQ job names on the ingest queue. */
export const INGEST_BATCH_JOB = 'ingest-batch';
export const FLUSH_JOB = 'flush-sweep';
/** Repeatable-job key for the flush sweep (stable so re-registration replaces it). */
const FLUSH_REPEATABLE_ID = 'ingest-flush-sweep';

@Injectable()
export class IngestWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(IngestWorker.name);
  private worker?: Worker;

  constructor(
    @Inject(INGEST_WORKER_CONNECTION) private readonly workerConnection: { connection: Redis },
    @Inject(INGEST_QUEUE_PROVIDER) private readonly queue: Queue,
    private readonly config: ConfigService,
    private readonly kernel: IngestKernel,
    private readonly tally: ExceptionTallyWriter,
    private readonly flushJob: FlushJobService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Guard: skip live Worker registration when disabled (unit/smoke tests boot
    // the DI graph with fake infra and must not open a real Redis Worker). An
    // integration test that wants the live worker sets INGEST_WORKER_ENABLED=1.
    if (!this.workerEnabled()) {
      return;
    }
    // Also skip if the queue is a fake without the BullMQ surface.
    if (typeof (this.queue as unknown as { add?: unknown }).add !== 'function') {
      return;
    }
    this.worker = new Worker(INGEST_QUEUE, async (job: Job) => this.dispatch(job), {
      ...this.workerConnection,
      concurrency: this.readIntEnv('INGEST_WORKER_CONCURRENCY', 4),
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error(`[worker] job ${job?.id ?? '?'} failed: ${err.message}`);
    });
    await this.registerFlushRepeatable();
  }

  /** Route a dequeued job to the batch processor or the flush sweep. */
  private async dispatch(job: Job): Promise<unknown> {
    if (job.name === FLUSH_JOB) {
      return this.flushJob.sweep();
    }
    return this.processBatch(job);
  }

  /**
   * Process one dequeued batch: run the kernel per event CONCURRENTLY (so raw
   * appends group-commit into one fsync), tally each drop/quarantine on the
   * arrival day. Returns a summary; returning = BullMQ acks the job.
   */
  async processBatch(job: Job<IngestBatchJob>): Promise<{ processed: number; counted: number }> {
    const data = job.data;
    const batchJobId = String(job.id ?? data.batch_id);
    const reportingOffsetMinutes = this.config.get<number>('REPORTING_OFFSET') ?? 0;

    const outcomes = await Promise.all(
      data.events.map((envelope) =>
        this.processOne(envelope, {
          reportingOffsetMinutes,
          now: Date.now(),
          // Provenance is server-derived (stamped by the door onto the job), not
          // re-derived per event from the body (P12/P5).
          provenance: data.provenance,
          batchJobId,
        }),
      ),
    );

    const counted = outcomes.filter((o) => o.counted).length;
    return { processed: outcomes.length, counted };
  }

  /**
   * Run one event through the kernel and tally its non-route verdict. Isolated:
   * an exception here is caught and logged (worker never crashes on one event,
   * T-01.31) — but the kernel itself does not throw on malformed input.
   */
  private async processOne(envelope: EventEnvelope, ctx: KernelContext): Promise<PipelineOutcome> {
    try {
      const outcome = await this.kernel.process(envelope, ctx);
      await this.tallyIfNeeded(envelope, ctx, outcome);
      return outcome;
    } catch (err) {
      this.logger.error(`[worker] event ${envelope.event_id} threw (isolated): ${String(err)}`);
      return {
        verdicts: { dedup_passed: false, seal_state: 'open', disposition: 'drop', reason: 'unparseable' },
        counted: false,
      };
    }
  }

  /** Increment EXCEPTION_TALLY (arrival-day) for a drop or quarantine verdict. */
  private async tallyIfNeeded(envelope: EventEnvelope, ctx: KernelContext, outcome: PipelineOutcome): Promise<void> {
    const { disposition, reason } = outcome.verdicts;
    if (disposition === 'route' || reason === undefined) {
      return;
    }
    // Arrival-day bucket = the server-received day (DARK-SPOT #4c). time_fallback
    // is an ACCEPT verdict (disposition route), so it is not tallied here.
    const arrivalDay = arrivalBucketDay(envelope.server_received_time, ctx.reportingOffsetMinutes);
    await this.tally.tally(envelope.game_id, arrivalDay, reason);
  }

  /** Register the repeatable flush sweep on `flush_interval_seconds`. */
  private async registerFlushRepeatable(): Promise<void> {
    const intervalSeconds = this.readIntEnv('FLUSH_INTERVAL_SECONDS', 300);
    await this.queue.add(
      FLUSH_JOB,
      {},
      {
        repeat: { every: intervalSeconds * 1000, key: FLUSH_REPEATABLE_ID },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  private readIntEnv(key: string, fallback: number): number {
    const value = this.config.get<number>(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  /**
   * Whether to register the live BullMQ Worker on boot. Enabled outside tests;
   * in NODE_ENV=test it stays OFF unless INGEST_WORKER_ENABLED is truthy, so unit
   * and smoke tests never open a real Redis Worker. Integration tests opt in.
   */
  private workerEnabled(): boolean {
    const flag = this.config.get<string>('INGEST_WORKER_ENABLED') ?? process.env.INGEST_WORKER_ENABLED;
    if (flag === '1' || flag === 'true') {
      return true;
    }
    const nodeEnv = this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV;
    return nodeEnv !== 'test';
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
  }
}
