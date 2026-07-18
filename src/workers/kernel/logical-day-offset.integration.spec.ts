import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { connectRedisOrNull, connectPostgresOrNull } from '../../testing/live-infra';
import { IngestKernel, type KernelContext } from './ingest-kernel';
import { WindowedDedupGate, UnimplementedPurchaseDedupGate } from '../../common/kernel/dedup';
import { RehydrateService } from '../../common/redis-keys/rehydrate';
import { DirtyRegistry } from '../flush/dirty-registry';
import { FlushService } from '../flush/flush.service';
import { FlushJobService } from '../flush/flush-job.service';
import {
  GenericHotUpdateHook,
  NoopDurableImmediateHook,
  NoopPiiScrubPort,
  PermissiveTypedValidator,
} from './default-hooks';
import { HotBucketWriter } from './hot-bucket.writer';
import { PostgresFloorProvider } from './postgres-floor.provider';
import { RedisNameCapGate } from './redis-name-cap.gate';
import { WorkerAckPort } from './ack.port';
import { ExceptionTallyWriter } from './exception-tally.writer';
import { RawFileService } from '../rawfile/raw-file.service';
import { ReadModelService } from '../../dashboard/read-model.service';
import { GameConfigService } from '../../config/game-config.service';
import { checkSealState } from '../../common/kernel/seal';
import { arrivalBucketDay } from '../../common/kernel/logical-day';
import { EventDayCountEntity } from '../../database/entities/event-day-count.entity';
import { ExceptionTallyEntity } from '../../database/entities/exception-tally.entity';
import type { EventEnvelope } from '../../common/contracts/envelope';

/**
 * DARK-SPOT #4 END-TO-END — logical-day at reporting_offset = +03:30 (210 min).
 *
 * The bug this guards is DORMANT at offset=0 (utcDay===logicalDay) and only bites
 * once an operator sets a non-UTC offset. The pure logical-day fns are unit-tested
 * (logical-day.spec.ts); this drives the FULL skew→floor→bucket→SEAL path through
 * the real kernel + live Redis + a live Postgres flush + the read-model, with
 * ctx.reportingOffsetMinutes = 210, and asserts:
 *
 *   1. an event whose corrected time is 2026-07-18T01:00:00Z (04:30 local) buckets
 *      into logical day 2026-07-18 (NOT 07-17) — the durable EVENT_DAY_COUNT row's
 *      utc_day is the LOGICAL day;
 *   2. an event at 2026-07-17T21:00:00Z (00:30 local NEXT day) buckets into
 *      2026-07-18 — the offset rolls it forward across the UTC boundary;
 *   3. the seal clock is shifted by the SAME 210 min (a corrected time whose
 *      logical day+grace has NOT elapsed is still `open`/`grace`; one that HAS is
 *      `sealed` → sealed_late, NOT folded into the day count);
 *   4. the read model does NOT re-apply the offset (no double-shift): the row it
 *      returns for logical day 2026-07-18 is the same day the floor bucketed into;
 *   5. a time_fallback event buckets on SERVER-RECEIVED day; an EXCEPTION_TALLY
 *      row buckets on the ARRIVAL day.
 *
 * Skips when the stack is unreachable.
 */

const configStub = { get: () => undefined } as unknown as ConfigService;
const noKnobs = {
  getNumber: async () => undefined,
  getBoolean: async () => true,
} as unknown as GameConfigService;

const OFFSET = 210; // +03:30 in minutes (Tehran)

interface Harness {
  redis: Redis;
  ds: DataSource;
  kernel: IngestKernel;
  tally: ExceptionTallyWriter;
  flushJob: FlushJobService;
  readModel: ReadModelService;
  dir: string;
}

function buildHarness(redis: Redis, ds: DataSource): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'ld-offset-'));
  const rehydrate = new RehydrateService(redis);
  const dirty = new DirtyRegistry(redis);
  const flush = new FlushService(redis, rehydrate, dirty, ds);
  const flushJob = new FlushJobService(dirty, flush);
  const floors = new PostgresFloorProvider(ds);
  const hotWriter = new HotBucketWriter(redis);
  const nameCapGate = new RedisNameCapGate(redis, configStub, noKnobs);
  const hotHook = new GenericHotUpdateHook(rehydrate, dirty, floors, hotWriter, noKnobs);
  const tally = new ExceptionTallyWriter(redis, rehydrate, dirty, floors);
  const rawFile = new RawFileService({ get: () => dir } as unknown as ConfigService, {
    dir,
    coldStorageEnabled: true,
  });
  const kernel = new IngestKernel(
    rawFile,
    new WindowedDedupGate(redis),
    new UnimplementedPurchaseDedupGate(),
    nameCapGate,
    new PermissiveTypedValidator(),
    new NoopDurableImmediateHook(),
    hotHook,
    new WorkerAckPort(),
    new NoopPiiScrubPort(),
  );
  return { redis, ds, kernel, tally, flushJob, readModel: new ReadModelService(redis, ds), dir };
}

async function run(h: Harness, envelope: EventEnvelope, ctx: KernelContext): Promise<void> {
  const outcome = await h.kernel.process(envelope, ctx);
  const { disposition, reason } = outcome.verdicts;
  if (disposition !== 'route' && reason !== undefined) {
    await h.tally.tally(
      envelope.game_id,
      arrivalBucketDay(envelope.server_received_time, ctx.reportingOffsetMinutes),
      reason,
    );
  }
}

/** No-skew envelope at a chosen instant (client==sent==received so corrected===that instant). */
function at(game: string, name: string, iso: string, i: number): EventEnvelope {
  const t = Date.parse(iso);
  return {
    game_id: game,
    event_id: `${name}-${i}-${Math.random().toString(36).slice(2)}`,
    name,
    kind: 'generic',
    client_event_time: t,
    client_sent_time: t,
    server_received_time: t,
    props: {},
  };
}

describe('logical-day @ reporting_offset=+3:30 end-to-end (DARK-SPOT #4) — live stack', () => {
  let redis: Redis | null;
  let ds: DataSource | null;
  const dirs: string[] = [];

  beforeAll(async () => {
    redis = await connectRedisOrNull();
    ds = await connectPostgresOrNull();
  });
  afterAll(async () => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    if (redis) {
      await redis.quit();
    }
    if (ds) {
      await ds.destroy();
    }
  });

  const game = () => `ld-${Math.random().toString(36).slice(2)}`;
  // "now" well inside the OPEN window of logical day 2026-07-18 at +3:30 so the
  // buckets stay mutable and flushable during the test.
  const NOW = Date.parse('2026-07-18T12:00:00Z');

  function ctx(): KernelContext {
    return { reportingOffsetMinutes: OFFSET, now: NOW, provenance: 'client', batchJobId: 'ld-job' };
  }

  async function countFor(g: string, name: string, day: string): Promise<number> {
    const row = await ds!
      .getRepository(EventDayCountEntity)
      .findOne({ where: { gameId: g, eventName: name, utcDay: day } });
    return row ? Number(row.count) : 0;
  }

  it('01:00Z (04:30 local) → logical day 2026-07-18, NOT 07-17', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds);
    dirs.push(h.dir);
    const g = game();
    // 01:00Z + 3:30 = 04:30 local same day → 2026-07-18.
    await run(h, at(g, 'morning', '2026-07-18T01:00:00Z', 0), ctx());
    await h.flushJob.sweep();

    expect(await countFor(g, 'morning', '2026-07-18')).toBe(1);
    // The naive utcDay(01:00Z) = 2026-07-18 too, so also prove the ROLL case below
    // where offset changes the day. This one confirms same-day correctness.
    expect(await countFor(g, 'morning', '2026-07-17')).toBe(0);
  });

  it('2026-07-17T21:00Z (00:30 local next day) → logical day 2026-07-18 (offset rolls it FORWARD)', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds);
    dirs.push(h.dir);
    const g = game();
    // 21:00Z on the 17th + 3:30 = 00:30 local on the 18th → logical day 2026-07-18.
    // At offset=0 this would have bucketed into 2026-07-17 — the dormant-bug case.
    await run(h, at(g, 'rollover', '2026-07-17T21:00:00Z', 0), ctx());
    await h.flushJob.sweep();

    expect(await countFor(g, 'rollover', '2026-07-18')).toBe(1); // rolled forward
    expect(await countFor(g, 'rollover', '2026-07-17')).toBe(0); // NOT the naive UTC day
  });

  it('the read model does NOT re-apply the offset (no double-shift)', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds);
    dirs.push(h.dir);
    const g = game();
    // Corrected 01:00Z → logical day 2026-07-18 at the FLOOR. The read model is
    // queried for that SAME logical day and must return the count — if it re-shifted
    // (double-apply), the row would appear under a different day and this would be 0.
    await run(h, at(g, 'once', '2026-07-18T01:00:00Z', 0), ctx());
    await run(h, at(g, 'once', '2026-07-18T01:00:01Z', 1), ctx());
    await h.flushJob.sweep();

    const day = await h.readModel.dayCounts(g, '2026-07-18');
    expect(day.perName['once']).toBe(2); // read at the SAME day the floor used
    // A double-shift would have put the count under 2026-07-19 (a second +3:30
    // across the 20:30Z-ish boundary would NOT apply to 01:00Z, but the guard is:
    // nothing appears under any OTHER day).
    const otherDay = await h.readModel.dayCounts(g, '2026-07-19');
    expect(otherDay.perName['once']).toBeUndefined();
  });

  it('the seal clock is shifted by the SAME 210 min (offset-consistent seal boundary)', async () => {
    if (!redis || !ds) return;
    // Prove the seal boundary uses the offset-shifted logical day (§2.3):
    // logical day 2026-07-18 at +3:30 runs 2026-07-17T20:30Z … 2026-07-18T20:30Z;
    // it seals at D_end + 48h grace = 2026-07-20T20:30Z.
    const corrected = Date.parse('2026-07-18T10:00:00Z'); // inside logical 2026-07-18
    // Just BEFORE the seal instant → still mutable (grace), NOT sealed.
    const justBefore = Date.parse('2026-07-20T20:29:00Z');
    expect(checkSealState({ correctedTime: corrected, now: justBefore, reportingOffsetMinutes: OFFSET })).toBe('grace');
    // Just AFTER → sealed. The SAME offset that shifted the bucket shifted the seal.
    const justAfter = Date.parse('2026-07-20T20:31:00Z');
    expect(checkSealState({ correctedTime: corrected, now: justAfter, reportingOffsetMinutes: OFFSET })).toBe('sealed');
    // Proof the boundary MOVED with the offset: pick a `now` (2026-07-20T22:00Z)
    // that is AFTER the +3:30 seal (20:30Z) but BEFORE the offset-0 seal
    // (D_end 2026-07-19T00:00Z + 48h = 2026-07-21T00:00Z). Same instant, same
    // corrected time → the +3:30 clock says SEALED, the offset-0 clock says GRACE.
    const between = Date.parse('2026-07-20T22:00:00Z');
    expect(checkSealState({ correctedTime: corrected, now: between, reportingOffsetMinutes: OFFSET })).toBe('sealed');
    expect(checkSealState({ correctedTime: corrected, now: between, reportingOffsetMinutes: 0 })).toBe('grace');
  });

  it('a SEALED-late event (past the offset-shifted seal) is quarantined, NOT folded into the day count', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds);
    dirs.push(h.dir);
    const g = game();
    // An event for logical day 2026-07-15 arriving "now" (2026-07-18) is long past
    // its offset-shifted seal → sealed_late, feeds the day count NOTHING.
    const outcome = await h.kernel.process(at(g, 'late', '2026-07-15T10:00:00Z', 0), ctx());
    expect(outcome.verdicts.seal_state).toBe('sealed');
    expect(outcome.counted).toBe(false);
    // sealed_late tallies on the ARRIVAL day (2026-07-18 logical), not the sealed day.
    await h.tally.tally(
      g,
      arrivalBucketDay(Date.parse('2026-07-15T10:00:00Z'), OFFSET), // arrival == its own received time here
      'sealed_late',
    );
    await h.flushJob.sweep();
    // The sealed logical day (2026-07-15) got NO count.
    expect(await countFor(g, 'late', '2026-07-15')).toBe(0);
  });

  it('time_fallback → SERVER-RECEIVED day; EXCEPTION_TALLY → ARRIVAL day (offset-shifted)', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds);
    dirs.push(h.dir);
    const g = game();
    // Craft a time_fallback: client_event_time absurdly far in the past (>26h from
    // arrival) so the sanity clamp fires → event buckets on SERVER-RECEIVED time.
    const received = Date.parse('2026-07-18T01:00:00Z'); // 04:30 local → logical 2026-07-18
    const fallbackEnv: EventEnvelope = {
      game_id: g,
      event_id: `fb-${Math.random().toString(36).slice(2)}`,
      name: 'fallback',
      kind: 'generic',
      client_event_time: Date.parse('2026-06-01T00:00:00Z'), // way in the past
      client_sent_time: Date.parse('2026-06-01T00:00:00Z'), // skew huge but corrected clamps
      server_received_time: received,
      props: {},
    };
    const outcome = await h.kernel.process(fallbackEnv, ctx());
    expect(outcome.counted).toBe(true); // time_fallback is still ACCEPTED
    await h.flushJob.sweep();
    // Buckets on the SERVER-RECEIVED logical day (2026-07-18), not the ancient client day.
    expect(await countFor(g, 'fallback', '2026-07-18')).toBe(1);
    expect(await countFor(g, 'fallback', '2026-06-01')).toBe(0);

    // A drop's EXCEPTION_TALLY buckets on the ARRIVAL day. Send a nameless drop
    // whose arrival is 21:00Z on the 17th (00:30 local 18th) → tally lands on the
    // offset-shifted arrival day 2026-07-18.
    const namelessArrival = Date.parse('2026-07-17T21:00:00Z');
    const drop: EventEnvelope = {
      game_id: g,
      event_id: `nd-${Math.random().toString(36).slice(2)}`,
      name: '', // nameless → drop
      kind: 'generic',
      client_event_time: namelessArrival,
      client_sent_time: namelessArrival,
      server_received_time: namelessArrival,
      props: {},
    };
    await run(h, drop, ctx()); // run() tallies on arrivalBucketDay(server_received, OFFSET)
    await h.flushJob.sweep();
    const tallyRow = await ds
      .getRepository(ExceptionTallyEntity)
      .findOne({ where: { gameId: g, utcDay: '2026-07-18', reason: 'nameless' } });
    expect(Number(tallyRow?.count)).toBe(1); // arrival day = offset-shifted 2026-07-18
    // NOT on the naive UTC arrival day (2026-07-17).
    const wrongDay = await ds
      .getRepository(ExceptionTallyEntity)
      .findOne({ where: { gameId: g, utcDay: '2026-07-17', reason: 'nameless' } });
    expect(wrongDay).toBeNull();
  });
});
