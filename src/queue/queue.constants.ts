/**
 * Name of the primary ingest queue. Later stories add processors that consume
 * from this queue.
 */
export const INGEST_QUEUE = 'ingest-queue';

/** Injection token for the BullMQ Queue instance bound to INGEST_QUEUE. */
export const INGEST_QUEUE_PROVIDER = 'INGEST_QUEUE_PROVIDER';

/**
 * Dedicated queue for the cold-storage nightly shipment sweep. It MUST be separate
 * from {@link INGEST_QUEUE}: BullMQ delivers each job to exactly one worker on a
 * queue, so two workers sharing one queue race — a cold-storage worker that pulled
 * an `ingest-batch`/`flush-sweep` job would return early (its "not mine" guard) and
 * silently complete-drop it. Isolating the sweep onto its own queue removes the race.
 */
export const COLD_STORAGE_QUEUE = 'cold-storage-queue';

/** Injection token for the BullMQ Queue instance bound to COLD_STORAGE_QUEUE. */
export const COLD_STORAGE_QUEUE_PROVIDER = 'COLD_STORAGE_QUEUE_PROVIDER';

/**
 * Injection token for the shared BullMQ worker connection options
 * (skeleton). Later stories build `new Worker(INGEST_QUEUE, processor, opts)`
 * from these options in `WorkersModule`. No processor is registered here.
 */
export const INGEST_WORKER_CONNECTION = 'INGEST_WORKER_CONNECTION';
