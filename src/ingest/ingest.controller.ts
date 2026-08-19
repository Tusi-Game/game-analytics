import { BadRequestException, Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { IngestAuthGuard } from './ingest-auth.guard';
import { GameId } from '../common/decorators/game-id.decorator';
import { Provenance } from '../common/decorators/provenance.decorator';
import type { Provenance as ProvenanceValue } from '../common/http/authenticated-request';
import { INGEST_QUEUE_PROVIDER } from '../queue/queue.constants';
import { INGEST_BATCH_JOB } from '../workers/ingest.worker';
import type { BatchAck, BatchRequest } from '../common/contracts';
import type { EventEnvelope } from '../common/contracts/envelope';
import type { IngestBatchJob } from '../common/contracts/queue-jobs';
import { IngestShedder } from './backpressure/ingest-shedder.service';

/**
 * Ingest front door — `POST /v1/events` (T-01.17–20).
 *
 * FAST-ACK (P11, DARK-SPOT #6): the door does the ABSOLUTE MINIMUM on the request
 * path — auth (guard), a shallow batch parse, stamp the wire `v` + the
 * server-derived `game_id` onto each envelope, enqueue the batch OPAQUE to
 * BullMQ, and ack `2xx {received: n}`. NO per-event verdicts, NO sync DB write, NO
 * PII scrub, NO raw append — all of that is worker-side. The ack is a
 * queue-acceptance receipt, not a validation promise.
 *
 * Trust boundary (P12/P5, DARK-SPOT #9): `game_id` + `provenance` come from the
 * guard (credential class), NEVER from the body. The body's `game_id` on each
 * envelope is OVERWRITTEN with the authenticated game before enqueue.
 *
 * Backpressure / rate-limit shedding (503/429) is Unit 4 — the seam is
 * {@link maybeShed}, a clean no-op hook here so Unit 4 slots its logic in BEFORE
 * the enqueue+ack without touching this method's shape.
 */
@Controller('v1')
@UseGuards(IngestAuthGuard)
export class IngestController {
  constructor(
    @Inject(INGEST_QUEUE_PROVIDER) private readonly queue: Queue,
    private readonly shedder: IngestShedder,
  ) {}

  @Post('events')
  @HttpCode(200)
  async ingest(
    @Body() batch: BatchRequest,
    @GameId() gameId: string | undefined,
    @Provenance() provenance: ProvenanceValue | undefined,
  ): Promise<BatchAck> {
    // The guard guarantees these; assert so the trust boundary is explicit.
    if (!gameId || !provenance) {
      throw new BadRequestException('Missing authenticated game scope');
    }

    // Shallow parse only. A body whose events array is unrecoverable → 400; a
    // recoverable body → 2xx with per-event verdicts deferred to the worker.
    const events = Array.isArray(batch?.events) ? batch.events : null;
    if (events === null) {
      throw new BadRequestException('Batch body must contain an events array');
    }

    // Unit-4 backpressure/rate-limit seam — refuse BEFORE any enqueue/ack.
    // On shed this THROWS (503 / 429 + Retry-After) so the enqueue + ack below
    // are never reached — nothing acked is ever dropped (P11, DARK-SPOT #6).
    await this.maybeShed(gameId, events.length);

    // Wire version: absent ⇒ 1 (§1.1). Stamped onto the job for rebuild dispatch.
    const v = typeof batch.v === 'number' && Number.isFinite(batch.v) ? batch.v : 1;
    const batchId = randomUUID();

    // Stamp the SERVER-DERIVED fields onto every envelope; any body-supplied value
    // is discarded here so the worker/kernel can never trust it (DARK-SPOT #9). The
    // SDK deliberately omits BOTH `game_id` and `server_received_time` (§1.1 —
    // collector-stamped): the front door IS the collector, so we stamp the receipt
    // clock here. Without it the kernel skew-corrects against `undefined`, produces
    // a NaN corrected time, and `logicalDay` throws → every event is dropped as
    // `unparseable` and NOTHING is counted. One instant for the whole batch keeps
    // the batch's arrival time coherent for skew / seal / arrival-day bucketing.
    const serverReceivedTime = Date.now();
    const stamped: EventEnvelope[] = events.map((event) => ({
      ...event,
      game_id: gameId,
      server_received_time: serverReceivedTime,
    }));

    const job: IngestBatchJob = { batch_id: batchId, v, provenance, events: stamped };

    // Enqueue OPAQUE + fast-ack — no blocking on processing (SC-002).
    await this.queue.add(INGEST_BATCH_JOB, job, { removeOnComplete: true, removeOnFail: 1000 });

    return { received: stamped.length, batch_id: batchId };
  }

  /**
   * Backpressure / per-game rate-limit shedding (Unit 4, T-00.66–69 / T-01.20).
   * Delegates to {@link IngestShedder}, which — strictly BEFORE the controller's
   * enqueue + ack — runs the global memory-watermark / queue-depth brake (503 +
   * Retry-After) then the per-game token-bucket rate cap (whole-batch 429 +
   * Retry-After + `rate_limited` arrival-day tally). Both are O(1) with NO
   * Postgres touch on the check path; either throws so the request path stops
   * before anything is enqueued or acked (P11 — never shed after ack).
   */
  private async maybeShed(gameId: string, eventCount: number): Promise<void> {
    await this.shedder.assertAdmissible(gameId, eventCount);
  }
}
