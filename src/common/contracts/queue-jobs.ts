import { EventEnvelope } from './envelope';

/**
 * A single envelope after front-door routing (skew correction, dedup, sealing).
 */
export interface RoutedRecord {
  envelope: EventEnvelope;
  /** Effective wire version, stamped by the front door. */
  v: number;
  /** Skew-corrected event time (epoch ms). */
  corrected_time: number;
  /** Logical reporting day "YYYY-MM-DD" (reporting_offset applied). */
  corrected_day: string;
  dedup_passed: boolean;
  /** True if the day was already sealed → record is quarantined. */
  sealed: boolean;
  provenance: 'client' | 'server';
}

/**
 * BullMQ job payload enqueued by the ingest front door and consumed by workers.
 */
export interface IngestJob {
  batch_id: string;
  routed_records: RoutedRecord[];
}
