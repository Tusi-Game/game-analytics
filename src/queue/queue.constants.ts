/**
 * Name of the primary ingest queue. Later stories add processors that consume
 * from this queue.
 */
export const INGEST_QUEUE = 'ingest-queue';

/** Injection token for the BullMQ Queue instance bound to INGEST_QUEUE. */
export const INGEST_QUEUE_PROVIDER = 'INGEST_QUEUE_PROVIDER';

/**
 * Injection token for the shared BullMQ worker connection options
 * (skeleton). Later stories build `new Worker(INGEST_QUEUE, processor, opts)`
 * from these options in `WorkersModule`. No processor is registered here.
 */
export const INGEST_WORKER_CONNECTION = 'INGEST_WORKER_CONNECTION';
