/**
 * Unit-3 SEAM placeholders for the two front-door↔worker ports the op-order
 * kernel calls but 002 does not build: step 4 (write-ahead raw append) and step
 * 9 (BullMQ ack). Bound in WorkersModule so `IngestKernel` is DI-resolvable
 * today; Unit 3 overrides these providers with the real raw-file writer and the
 * real queue ack.
 *
 * The raw-append placeholder is a NO-OP that still mints the ordering token —
 * NOT a throw — because the kernel's step ordering (and its tests) must run with
 * cold storage effectively off, exactly as the real "cold storage disabled" path
 * behaves (§3.1 step 4 "if cold storage on"). The ack placeholder is likewise a
 * no-op. Neither writes bytes; Unit 3 supplies the durable versions.
 */

import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '../../common/contracts/envelope';
import { AckPort, HotUpdatedToken, RawAppendedToken, RawAppendIntent, RawAppendPort } from './pipeline-steps';

/** Injection token for the step-4 raw-append port (Unit 3 fills). */
export const RAW_APPEND_PORT = 'RAW_APPEND_PORT';
/** Injection token for the step-9 ack port (Unit 3 fills). */
export const ACK_PORT = 'ACK_PORT';

/**
 * No-op raw-append placeholder = the "cold storage off" path. Mints the
 * proof-of-append token so downstream stages can run, but reports `appended:
 * false` (no bytes written). Unit 3 replaces it with the fsync'd day-file writer.
 */
@Injectable()
export class NoopRawAppendPort implements RawAppendPort {
  async append(
    _envelope: EventEnvelope,
    _correctedDay: string,
    _intent: RawAppendIntent,
    _batchJobId: string,
  ): Promise<{ token: RawAppendedToken; appended: boolean }> {
    return { token: {} as RawAppendedToken, appended: false };
  }
}

/** No-op ack placeholder. Unit 3 replaces it with the BullMQ job ack. */
@Injectable()
export class NoopAckPort implements AckPort {
  async ack(_token: HotUpdatedToken, _batchJobId: string): Promise<void> {
    // Unit 3: job.moveToCompleted / return from the BullMQ processor.
  }
}
