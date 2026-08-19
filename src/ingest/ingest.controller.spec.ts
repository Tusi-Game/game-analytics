import { BadRequestException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { IngestController } from './ingest.controller';
import type { BatchRequest } from '../common/contracts';
import type { IngestBatchJob } from '../common/contracts/queue-jobs';
import type { IngestShedder } from './backpressure/ingest-shedder.service';

/**
 * Ingest front door (T-01.17–19). Proves the fast-ack shape and the trust
 * boundary: the enqueued job carries the SERVER-DERIVED game_id (body game_id is
 * overwritten, DARK-SPOT #9), the wire `v` defaults to 1, and the door does NO
 * per-event processing (just enqueue + ack).
 */

class FakeQueue {
  readonly added: Array<{ name: string; data: IngestBatchJob }> = [];
  async add(name: string, data: IngestBatchJob): Promise<{ id: string }> {
    this.added.push({ name, data });
    return { id: 'job-x' };
  }
}

/** No-op shedder — these fast-ack tests exercise the admit path only. */
class PassShedder {
  readonly calls: Array<{ gameId: string; eventCount: number }> = [];
  async assertAdmissible(gameId: string, eventCount: number): Promise<void> {
    this.calls.push({ gameId, eventCount });
  }
}

function makeController(queue: FakeQueue, shedder: PassShedder = new PassShedder()): IngestController {
  return new IngestController(queue as unknown as Queue, shedder as unknown as IngestShedder);
}

function batch(overrides: Partial<BatchRequest> = {}): BatchRequest {
  const t = Date.parse('2026-07-18T12:00:00Z');
  return {
    sdk: { name: 'sdk', version: '1' },
    events: [
      {
        game_id: 'game-99', // body claims a DIFFERENT game — must be ignored
        event_id: 'evt-1',
        name: 'login',
        kind: 'generic',
        client_event_time: t,
        client_sent_time: t,
        server_received_time: t,
        props: {},
      },
    ],
    ...overrides,
  };
}

describe('IngestController fast-ack', () => {
  it('acks {received:n, batch_id} and enqueues opaque with server-derived game_id (#9)', async () => {
    const queue = new FakeQueue();
    const controller = makeController(queue);

    const ack = await controller.ingest(batch(), 'game-42', 'client');

    expect(ack.received).toBe(1);
    expect(typeof ack.batch_id).toBe('string');
    expect(queue.added).toHaveLength(1);
    const job = queue.added[0]!.data;
    // Trust boundary: the enqueued envelope's game_id is the AUTHED game, not body.
    expect(job.events[0]!.game_id).toBe('game-42');
    expect(job.provenance).toBe('client');
    expect(job.v).toBe(1); // absent on wire ⇒ 1
  });

  it('stamps a numeric server_received_time even when the SDK omits it (else the kernel drops every event)', async () => {
    const queue = new FakeQueue();
    const controller = makeController(queue);

    // Real SDK shape: the envelope-factory structurally OMITS server_received_time
    // (collector-stamped, §1.1). The door must fill it in.
    const t = Date.parse('2026-07-18T12:00:00Z');
    const sdkBatch: BatchRequest = {
      sdk: { name: 'sdk', version: '1' },
      events: [
        {
          event_id: 'evt-1',
          name: 'session',
          kind: 'session',
          client_event_time: t,
          client_sent_time: t,
          props: {},
        } as unknown as BatchRequest['events'][number],
      ],
    };

    await controller.ingest(sdkBatch, 'game-42', 'client');

    const stamped = queue.added[0]!.data.events[0]!;
    expect(typeof stamped.server_received_time).toBe('number');
    expect(Number.isFinite(stamped.server_received_time)).toBe(true);
  });

  it('overwrites any body-supplied server_received_time (trust boundary #9)', async () => {
    const queue = new FakeQueue();
    const controller = makeController(queue);

    // A hostile/legacy body claims an ancient arrival time — must be discarded.
    await controller.ingest(
      batch({ events: [{ ...batch().events[0]!, server_received_time: 1 }] }),
      'game-42',
      'client',
    );

    const stamped = queue.added[0]!.data.events[0]!;
    expect(stamped.server_received_time).not.toBe(1);
    expect(Number.isFinite(stamped.server_received_time)).toBe(true);
  });

  it('stamps the wire v when present', async () => {
    const queue = new FakeQueue();
    const controller = makeController(queue);
    await controller.ingest(batch({ v: 2 }), 'game-42', 'client');
    expect(queue.added[0]!.data.v).toBe(2);
  });

  it('rejects a body without an events array (400)', async () => {
    const queue = new FakeQueue();
    const controller = makeController(queue);
    await expect(
      controller.ingest({ sdk: { name: 's', version: '1' } } as unknown as BatchRequest, 'game-42', 'client'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(queue.added).toHaveLength(0);
  });

  it('rejects when the authenticated scope is missing (guard contract)', async () => {
    const queue = new FakeQueue();
    const controller = makeController(queue);
    await expect(controller.ingest(batch(), undefined, undefined)).rejects.toBeInstanceOf(BadRequestException);
  });
});
