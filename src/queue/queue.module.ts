import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Queue, type WorkerOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { INGEST_QUEUE, INGEST_QUEUE_PROVIDER, INGEST_WORKER_CONNECTION } from './queue.constants';

/**
 * Raw BullMQ wiring (FR-006). Exports:
 *  - a `Queue` bound to the `ingest-queue`, reusing the ioredis client from
 *    RedisModule as its connection, and
 *  - a worker-connection skeleton (`INGEST_WORKER_CONNECTION`): the shared
 *    `WorkerOptions` a later story uses to build `new Worker(INGEST_QUEUE,
 *    processor, opts)` in `WorkersModule`.
 *
 * No processor is registered and no `Worker` is instantiated here — the worker
 * registration skeleton exists, but consumers are defined per-story later.
 *
 * Deliberately NOT using `@nestjs/bullmq` — we keep direct BullMQ access for
 * backpressure and rate-limiting control (spec rationale, FR-006).
 */
@Global()
@Module({
  providers: [
    {
      provide: INGEST_QUEUE_PROVIDER,
      inject: [REDIS_CLIENT],
      useFactory: (connection: Redis): Queue =>
        new Queue(INGEST_QUEUE, {
          connection,
        }),
    },
    {
      provide: INGEST_WORKER_CONNECTION,
      inject: [REDIS_CLIENT],
      useFactory: (connection: Redis): WorkerOptions => ({
        connection,
      }),
    },
  ],
  exports: [INGEST_QUEUE_PROVIDER, INGEST_WORKER_CONNECTION],
})
export class QueueModule implements OnApplicationShutdown {
  constructor(@Inject(INGEST_QUEUE_PROVIDER) private readonly ingestQueue: Queue) {}

  async onApplicationShutdown(): Promise<void> {
    await this.ingestQueue.close();
  }
}
