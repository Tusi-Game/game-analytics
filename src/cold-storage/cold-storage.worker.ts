/**
 * Cold-storage nightly worker (T-07.8) — the BullMQ repeatable that drives flow
 * (b) and, per the manager's settled decision, IS the seal-driver.
 *
 * Registers one repeatable job on `cold_storage_upload_schedule` (stable key so a
 * re-register replaces it; losing the schedule merely re-registers it — the only
 * scheduling state, no Redis job-lock). On each fire it runs
 * {@link NightlyShipmentService.run}, which seal-drives every sealed day, ships
 * sealed-unshipped files, and runs the retention + S3-expiry passes.
 *
 * Mirrors {@link IngestWorker}: reuses the shared INGEST_QUEUE + worker
 * connection (one queue, distinct job name), and stays OFF under NODE_ENV=test
 * unless COLD_STORAGE_WORKER_ENABLED is set — so unit/smoke DI graphs never open a
 * real Redis Worker; integration tests drive the service directly.
 *
 * cold-off (`cold_storage_enabled=off`) is a per-game no-op INSIDE the shipment
 * service (NightlyShipmentService.runGame short-circuits), so the job itself is
 * always safe to fire.
 */

import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { COLD_STORAGE_QUEUE, COLD_STORAGE_QUEUE_PROVIDER, INGEST_WORKER_CONNECTION } from '../queue/queue.constants';
import { NightlyShipmentService, type ShipmentSummary } from './nightly-shipment.service';

/** BullMQ job name for the cold-storage shipment sweep. */
export const COLD_STORAGE_JOB = 'cold-storage-shipment';
/** Repeatable-job key (stable so re-registration replaces it). */
const COLD_STORAGE_REPEATABLE_ID = 'cold-storage-upload-schedule';
/** Default nightly cadence in ms (24 h) when the schedule is "nightly"/unset. */
const NIGHTLY_MS = 24 * 60 * 60_000;

@Injectable()
export class ColdStorageWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ColdStorageWorker.name);
  private worker?: Worker;

  constructor(
    @Inject(INGEST_WORKER_CONNECTION) private readonly workerConnection: { connection: Redis },
    @Inject(COLD_STORAGE_QUEUE_PROVIDER) private readonly queue: Queue,
    private readonly config: ConfigService,
    private readonly shipment: NightlyShipmentService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.workerEnabled()) {
      return;
    }
    if (typeof (this.queue as unknown as { add?: unknown }).add !== 'function') {
      return;
    }
    this.worker = new Worker(
      COLD_STORAGE_QUEUE,
      async (job: Job) => {
        // The cold-storage queue only carries COLD_STORAGE_JOB, but keep the guard
        // as a defensive no-op in case a stray job ever lands here.
        if (job.name !== COLD_STORAGE_JOB) {
          return;
        }
        return this.dispatch();
      },
      { ...this.workerConnection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      if (job?.name === COLD_STORAGE_JOB) {
        this.logger.error(`[cold-storage] job ${job?.id ?? '?'} failed: ${err.message}`);
      }
    });
    await this.registerRepeatable();
  }

  /** Run one shipment pass (public so integration tests can drive it directly). */
  async dispatch(): Promise<ShipmentSummary> {
    const summary = await this.shipment.run();
    this.logger.log(
      `[cold-storage] run: games=${summary.games} sealed=${summary.sealed} shipped=${summary.shipped} ` +
        `flagged=${summary.flagged} deleted=${summary.deleted} failed=${summary.failed} expired=${summary.expired}`,
    );
    return summary;
  }

  /** Register the repeatable shipment sweep on the configured cadence. */
  private async registerRepeatable(): Promise<void> {
    await this.queue.add(
      COLD_STORAGE_JOB,
      {},
      {
        repeat: { every: this.cadenceMs(), key: COLD_STORAGE_REPEATABLE_ID },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  /**
   * Resolve the repeat interval. `cold_storage_upload_schedule` is per-game config,
   * but a BullMQ repeatable is platform-scoped (the run then honors each game's
   * enable/skip inside the service). A numeric env override
   * (COLD_STORAGE_INTERVAL_MS) wins for tests; otherwise nightly (24 h).
   */
  private cadenceMs(): number {
    const override = this.config.get<number>('COLD_STORAGE_INTERVAL_MS');
    return typeof override === 'number' && Number.isFinite(override) && override > 0 ? override : NIGHTLY_MS;
  }

  private workerEnabled(): boolean {
    const flag = this.config.get<string>('COLD_STORAGE_WORKER_ENABLED') ?? process.env.COLD_STORAGE_WORKER_ENABLED;
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
