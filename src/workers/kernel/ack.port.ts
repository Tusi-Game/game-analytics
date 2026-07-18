/**
 * Concrete ACK_PORT (step 9, T-01.29) — replaces `NoopAckPort`.
 *
 * At-least-once semantics with job_id threading (foundation §3.1 step 9): the
 * BullMQ JOB is acked when the worker's processor function RETURNS after every
 * record in the batch has completed step 8 — that is BullMQ's completion model
 * (return = moveToCompleted, throw = retry). The kernel's per-RECORD `ack.ack()`
 * therefore cannot itself complete the job (a batch has many records, one job);
 * it is the per-record "this record reached step 8 durably" signal that gates the
 * step-8→ack ordering token.
 *
 * This port records the per-record ack for observability + tests and is the seam
 * where a future per-record checkpoint (partial-batch replay) would hook in. The
 * batch-level BullMQ completion is owned by the processor (see ingest.worker.ts):
 * a crash between step 6 and the processor's return → the retried job re-runs and
 * every already-counted record is a dedup no-op → bounded undercount
 * (approximate-OK), never a double-count.
 */

import { Injectable } from '@nestjs/common';
import type { AckPort, HotUpdatedToken } from './pipeline-steps';

/** A per-record ack observation (batch job id + monotonically increasing seq). */
export interface AckObservation {
  batchJobId: string;
  seq: number;
}

@Injectable()
export class WorkerAckPort implements AckPort {
  private seq = 0;
  private readonly lastByJob = new Map<string, number>();

  async ack(_token: HotUpdatedToken, batchJobId: string): Promise<void> {
    this.seq += 1;
    this.lastByJob.set(batchJobId, (this.lastByJob.get(batchJobId) ?? 0) + 1);
  }

  /** How many records have been acked for a batch (tests / observability). */
  ackedCount(batchJobId: string): number {
    return this.lastByJob.get(batchJobId) ?? 0;
  }

  /** Total acks observed since start (tests / observability). */
  get total(): number {
    return this.seq;
  }
}
