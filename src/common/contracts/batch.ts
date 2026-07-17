import { EventEnvelope } from './envelope';

/**
 * Wire payload of a batch POST to the ingest front door.
 */
export interface BatchRequest {
  /** Wire version. Absent ⇒ 1. */
  v?: number;
  sdk: { name: string; version: string };
  events: EventEnvelope[];
}

/**
 * Fast-ack response returned by the ingest front door.
 */
export interface BatchAck {
  /** Number of events accepted into the queue. */
  received: number;
  /** Server-assigned batch id for tracing. */
  batch_id: string;
}
