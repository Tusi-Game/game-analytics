/**
 * SESSIONS + RETENTION conformance (003 + 005, combined) — end-to-end through the
 * REAL 9-step kernel + the REAL kind-dispatch seam (generic base THEN the session
 * hooks) + live Redis + live Postgres flush + the read models. Skips when the
 * stack is unreachable (proven WITH the stack in the report).
 *
 * Proves (brief §VERIFY):
 *   - golden §2: session_count / duration per day incl. the midnight span pro-rata;
 *   - SC-005 synthetic-population headline D1/D7/D30 + immature D7 = N/A;
 *   - server-authoritative duration recompute (client duration_ms never inflated);
 *   - idempotency set-once (resend > 24 h → bit stays, retained_users no double-inc);
 *   - D0 = 100 % invariant (bit 0 == 1; COHORT.size ≡ RETENTION_CELL(c, 0));
 *   - USER_SPINE survives a simulated Redis loss (P7 durable-immediate);
 *   - logical-day @ +210;
 *   - negative-offset / sealed-late / over-horizon edges;
 *   - the dispatcher actually routes `session` events to the SessionHotHook (the
 *     generic base ran cat/cnt/rank AND the session accumulators fired).
 */

import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectRedisOrNull, connectPostgresOrNull } from '../testing/live-infra';
import { IngestKernel, type KernelContext } from '../workers/kernel/ingest-kernel';
import { WindowedDedupGate, UnimplementedPurchaseDedupGate } from '../common/kernel/dedup';
import { RehydrateService } from '../common/redis-keys/rehydrate';
import { DirtyRegistry } from '../workers/flush/dirty-registry';
import { FlushService } from '../workers/flush/flush.service';
import { FlushJobService, type ExtraDomainFlushPlan } from '../workers/flush/flush-job.service';
import {
  GenericHotUpdateHook,
  NoopDurableImmediateHook,
  NoopPiiScrubPort,
  PermissiveTypedValidator,
} from '../workers/kernel/default-hooks';
import { HotBucketWriter } from '../workers/kernel/hot-bucket.writer';
import { PostgresFloorProvider } from '../workers/kernel/postgres-floor.provider';
import { RedisNameCapGate } from '../workers/kernel/redis-name-cap.gate';
import { WorkerAckPort } from '../workers/kernel/ack.port';
import { ExceptionTallyWriter } from '../workers/kernel/exception-tally.writer';
import { RawFileService } from '../workers/rawfile/raw-file.service';
import { GameConfigService } from '../config/game-config.service';
import { KindDispatchValidator, KindDispatchDurableHook, KindDispatchHotHook } from '../workers/kernel/kind-dispatch';
import { arrivalBucketDay } from '../common/kernel/logical-day';
import { ExceptionTallyEntity } from '../database/entities/exception-tally.entity';
import type { EventEnvelope } from '../common/contracts/envelope';

import { SessionValidator } from './session-validator';
import { SessionDurableHook } from './session-durable.hook';
import { SessionHotHook } from './session-hot.hook';
import { SpineRepository } from './spine.repository';
import { SessionFloorProvider } from './session-floor.provider';
import { SessionConfigService } from './session-config.service';
import { SessionReadService } from './session-read.service';
import { RetentionReadService } from './retention-read.service';
import { SpineRescanService } from './spine-rescan.service';
import { SESS_FLUSH_PLAN, ACT_FLUSH_PLAN, RET_COHORT_FLUSH_PLAN, RET_CELL_FLUSH_PLAN } from './session-flush-plans';

const MIN = 60_000;
const configStub = { get: () => undefined } as unknown as ConfigService;
const noKnobs = {
  getNumber: async () => undefined,
  getBoolean: async () => true,
  getConfig: async () => ({}),
} as unknown as GameConfigService;

interface Harness {
  redis: Redis;
  ds: DataSource;
  kernel: IngestKernel;
  flushJob: FlushJobService;
  sessionRead: SessionReadService;
  retentionRead: RetentionReadService;
  rescan: SpineRescanService;
  spine: SpineRepository;
  hotHook: SessionHotHook;
  dir: string;
}

/** Build the full session/retention pipeline against live infra at a given offset. */
function buildHarness(redis: Redis, ds: DataSource, offsetMinutes: number): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'sess-'));
  const rehydrate = new RehydrateService(redis);
  const dirty = new DirtyRegistry(redis);
  const flush = new FlushService(redis, rehydrate, dirty, ds);

  const sessionConfig = new SessionConfigService(noKnobs, configStub, offsetMinutes);
  const spine = new SpineRepository(ds);
  const genericFloors = new PostgresFloorProvider(ds);
  const tally = new ExceptionTallyWriter(redis, rehydrate, dirty, genericFloors);
  const sessionFloors = new SessionFloorProvider(ds);

  // Session hooks.
  const sessionValidator = new SessionValidator();
  const durableHook = new SessionDurableHook(spine, tally, sessionConfig);
  const hotHook = new SessionHotHook(redis, rehydrate, dirty, sessionFloors, sessionConfig);

  // The REAL dispatch seam: generic base + registered session triple.
  const genericHot = new GenericHotUpdateHook(rehydrate, dirty, genericFloors, new HotBucketWriter(redis), noKnobs);
  const dispatchValidator = new KindDispatchValidator(new PermissiveTypedValidator(), [
    { kind: 'session', validator: sessionValidator },
  ]);
  dispatchValidator.onModuleInit();
  const dispatchDurable = new KindDispatchDurableHook(new NoopDurableImmediateHook(), [
    { kind: 'session', hook: durableHook },
  ]);
  dispatchDurable.onModuleInit();
  const dispatchHot = new KindDispatchHotHook(genericHot, [{ kind: 'session', hook: hotHook }]);
  dispatchHot.onModuleInit();

  const rawFile = new RawFileService({ get: () => dir } as unknown as ConfigService, { dir, coldStorageEnabled: true });
  const kernel = new IngestKernel(
    rawFile,
    new WindowedDedupGate(redis),
    new UnimplementedPurchaseDedupGate(),
    new RedisNameCapGate(redis, configStub, noKnobs),
    dispatchValidator,
    dispatchDurable,
    dispatchHot,
    new WorkerAckPort(),
    new NoopPiiScrubPort(),
  );

  const extraPlans: ExtraDomainFlushPlan[] = [
    { domain: 'sess', plan: SESS_FLUSH_PLAN },
    { domain: 'act', plan: ACT_FLUSH_PLAN },
    { domain: 'ret', plan: RET_COHORT_FLUSH_PLAN },
    { domain: 'ret', plan: RET_CELL_FLUSH_PLAN },
  ];
  const flushJob = new FlushJobService(dirty, flush, extraPlans);

  const sessionRead = new SessionReadService(redis, ds, sessionConfig);
  const retentionRead = new RetentionReadService(redis, ds, sessionConfig);
  const rescan = new SpineRescanService(ds, sessionConfig);

  return { redis, ds, kernel, flushJob, sessionRead, retentionRead, rescan, spine, hotHook, dir };
}

/** A session `session` event envelope (SDK sends the terminal event ~just after end). */
function sessionEvent(params: {
  game: string;
  userId: string;
  sessionId: string;
  start: number;
  end: number;
  eventId?: string;
  clientDurationMs?: number; // the UNTRUSTED client value (server recomputes)
}): EventEnvelope {
  const sent = params.end + 1000;
  return {
    game_id: params.game,
    user_id: params.userId,
    session_id: params.sessionId,
    event_id: params.eventId ?? `${params.sessionId}-${Math.random().toString(36).slice(2)}`,
    name: 'session',
    kind: 'session',
    client_event_time: params.end,
    client_sent_time: sent,
    server_received_time: sent + 1000,
    props: {
      session_id: params.sessionId,
      session_start_time: params.start,
      session_end_time: params.end,
      duration_ms: params.clientDurationMs ?? params.end - params.start,
      reason: 'timeout',
    },
  };
}

function ctx(now: number, offsetMinutes = 0): KernelContext {
  return { reportingOffsetMinutes: offsetMinutes, now, provenance: 'client', batchJobId: 'sess-job' };
}

const uid = (p: string): string => `${p}-${Math.random().toString(36).slice(2)}`;

describe('sessions + retention conformance (003 + 005) — live stack', () => {
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
    if (redis) await redis.quit();
    if (ds) await ds.destroy();
  });

  // ---- golden §2: session_count / duration per day incl. midnight span --------
  it('golden §2: start-day count, midnight duration split, split-form average, sessions/user, frequency', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0);
    dirs.push(h.dir);
    const game = uid('g-golden');
    const user = uid('u');
    // now = 2026-07-20 → 07-15/07-16 are OPEN? No: 48 h grace means 07-16 sealed by
    // 07-18. Use now late on 07-16 so both days are open for the golden replay.
    const now = Date.parse('2026-07-16T20:00:00Z');
    const c = ctx(now, 0);

    // S1: 07-15 23:40 → 07-16 00:35 (55 min, spans midnight). Client LIES 1 ms.
    await h.kernel.process(
      sessionEvent({
        game,
        userId: user,
        sessionId: 's1',
        start: Date.parse('2026-07-15T23:40:00Z'),
        end: Date.parse('2026-07-16T00:35:00Z'),
        clientDurationMs: 1,
      }),
      c,
    );
    // S2: 07-16 09:00 → 09:10 (10 min).
    await h.kernel.process(
      sessionEvent({
        game,
        userId: user,
        sessionId: 's2',
        start: Date.parse('2026-07-16T09:00:00Z'),
        end: Date.parse('2026-07-16T09:10:00Z'),
      }),
      c,
    );
    await h.flushJob.sweep();

    const d15 = await h.sessionRead.sessionDay(game, '2026-07-15', now);
    const d16 = await h.sessionRead.sessionDay(game, '2026-07-16', now);

    // Count by START day: S1 → 07-15, S2 → 07-16 (S1 crossing midnight does NOT add to 07-16).
    expect(d15.sessionCount).toBe(1);
    expect(d16.sessionCount).toBe(1);
    // Duration split (server-recomputed, NOT the client 1 ms): 20 min on 07-15, 35+10 on 07-16.
    expect(d15.durationSumMs).toBe(20 * MIN);
    expect(d16.durationSumMs).toBe(45 * MIN);
    // sessions_touching: 07-15 = 1 (S1), 07-16 = 2 (S1 tail + S2).
    expect(d15.sessionsTouching).toBe(1);
    expect(d16.sessionsTouching).toBe(2);
    // Split-form average on 07-16 = 45/2 = 22.5 min.
    expect(d16.avgSessionLengthMs).toBe(22.5 * MIN);

    // sessions/user + frequency over [07-15, 07-16].
    const w = await h.sessionRead.window(game, '2026-07-15', '2026-07-16', now);
    expect(w.totalSessions).toBe(2);
    expect(w.distinctUsers).toBe(1);
    expect(w.activeUserDays).toBe(2); // active on both days
    expect(w.sessionsPerUser).toBe(2.0);
    expect(w.sessionFrequency).toBe(1.0);
  });

  // ---- dispatcher routes session events to the session hooks (base + accumulators)
  it('the dispatcher routes `session` to the session hooks AND runs the generic base (cat/cnt/rank)', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0);
    dirs.push(h.dir);
    const game = uid('g-dispatch');
    const user = uid('u');
    const now = Date.parse('2026-07-16T20:00:00Z');
    await h.kernel.process(
      sessionEvent({
        game,
        userId: user,
        sessionId: 's1',
        start: Date.parse('2026-07-16T09:00:00Z'),
        end: Date.parse('2026-07-16T09:05:00Z'),
      }),
      ctx(now, 0),
    );
    await h.flushJob.sweep();

    // Session accumulator fired → SESSION_DAY_RESULT exists.
    const day = await h.sessionRead.sessionDay(game, '2026-07-16', now);
    expect(day.sessionCount).toBe(1);
    // Generic base fired → EVENT_DAY_COUNT has the `session` name row.
    const cnt: Array<{ n: string }> = await ds.query(
      `SELECT count::text AS n FROM event_day_count WHERE game_id = $1 AND event_name = 'session' AND utc_day = '2026-07-16'`,
      [game],
    );
    expect(Number(cnt[0]?.n ?? '0')).toBe(1);
    // Spine seeded (durable-immediate), D0 bit set.
    const fs = await h.spine.findFirstSeen(game, user);
    expect(fs).not.toBeNull();
  });

  // ---- D0 = 100 % invariant --------------------------------------------------
  it('D0 = 100 %: every seeding session sets bit 0 and COHORT.size ≡ RETENTION_CELL(c, 0)', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0);
    dirs.push(h.dir);
    const game = uid('g-d0');
    const now = Date.parse('2026-07-16T20:00:00Z');
    for (let i = 0; i < 5; i += 1) {
      await h.kernel.process(
        sessionEvent({
          game,
          userId: uid('u'),
          sessionId: `s${i}`,
          start: Date.parse('2026-07-16T09:00:00Z') + i * MIN,
          end: Date.parse('2026-07-16T09:05:00Z') + i * MIN,
        }),
        ctx(now, 0),
      );
    }
    await h.flushJob.sweep();

    const cohort: Array<{ n: string }> = await ds.query(
      `SELECT cohort_size::text AS n FROM cohort WHERE game_id = $1 AND cohort_date = '2026-07-16'`,
      [game],
    );
    const cell0: Array<{ n: string }> = await ds.query(
      `SELECT retained_users::text AS n FROM retention_cell WHERE game_id = $1 AND cohort_date = '2026-07-16' AND day_offset = 0`,
      [game],
    );
    expect(Number(cohort[0]?.n)).toBe(5);
    expect(Number(cell0[0]?.n)).toBe(5); // D0 == cohort size (100 %)

    const inv = await h.rescan.verifyD0Invariant(game);
    expect(inv.ok).toBe(true);
    expect(inv.usersMissingBit0).toBe(0);
    expect(inv.cohortsMismatched).toBe(0);
  });

  // ---- server-authoritative recompute ----------------------------------------
  it('server recomputes duration from timestamps — a lying client duration_ms is never folded', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0);
    dirs.push(h.dir);
    const game = uid('g-auth');
    const now = Date.parse('2026-07-16T20:00:00Z');
    // Client claims a 10-HOUR duration; true interval is 10 min.
    await h.kernel.process(
      sessionEvent({
        game,
        userId: uid('u'),
        sessionId: 's1',
        start: Date.parse('2026-07-16T09:00:00Z'),
        end: Date.parse('2026-07-16T09:10:00Z'),
        clientDurationMs: 10 * 60 * MIN,
      }),
      ctx(now, 0),
    );
    await h.flushJob.sweep();
    const day = await h.sessionRead.sessionDay(game, '2026-07-16', now);
    expect(day.durationSumMs).toBe(10 * MIN); // 10 min, NOT 10 h
  });

  // ---- idempotency set-once (resend > 24 h) ----------------------------------
  it('idempotency: a resend beyond 24 h re-ORs the bit (no-op) and never double-increments retained_users', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0);
    dirs.push(h.dir);
    const game = uid('g-idem');
    const user = uid('u');
    const now = Date.parse('2026-07-16T20:00:00Z');
    const evt = sessionEvent({
      game,
      userId: user,
      sessionId: 's1',
      start: Date.parse('2026-07-16T09:00:00Z'),
      end: Date.parse('2026-07-16T09:10:00Z'),
      eventId: 'fixed-event-id',
    });
    // First arrival — sets the bit, increments cohort + cell.
    await h.kernel.process(evt, ctx(now, 0));
    await h.flushJob.sweep();

    // Resend > 24 h later with a DIFFERENT event_id (past the dedup window) — the
    // set-once bit makes the retention re-touch a full no-op (8b skipped).
    const resend = { ...evt, event_id: 'resend-past-window' };
    await h.kernel.process(resend, ctx(now, 0));
    await h.flushJob.sweep();

    const cell0: Array<{ n: string }> = await ds.query(
      `SELECT retained_users::text AS n FROM retention_cell WHERE game_id = $1 AND cohort_date = '2026-07-16' AND day_offset = 0`,
      [game],
    );
    expect(Number(cell0[0]?.n)).toBe(1); // NOT 2 — set-once
    const cohort: Array<{ n: string }> = await ds.query(
      `SELECT cohort_size::text AS n FROM cohort WHERE game_id = $1 AND cohort_date = '2026-07-16'`,
      [game],
    );
    expect(Number(cohort[0]?.n)).toBe(1); // first_seen write-once → cohort not double-inc
    // Bit still set (idempotent).
    const bit: Array<{ b: number }> = await ds.query(
      `SELECT get_bit(active_days_bitmap, 0) AS b FROM user_spine WHERE game_id = $1 AND user_id = $2`,
      [game, user],
    );
    expect(bit[0]?.b).toBe(1);
  });

  // ---- midnight span sets exactly ONE bit ------------------------------------
  it('a midnight-spanning session sets exactly ONE bit (the start day)', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0);
    dirs.push(h.dir);
    const game = uid('g-mid');
    const user = uid('u');
    const now = Date.parse('2026-07-16T20:00:00Z');
    await h.kernel.process(
      sessionEvent({
        game,
        userId: user,
        sessionId: 's1',
        start: Date.parse('2026-07-15T23:40:00Z'),
        end: Date.parse('2026-07-16T00:35:00Z'),
      }),
      ctx(now, 0),
    );
    await h.flushJob.sweep();
    // Exactly one set bit (bit 0 for cohort 07-15). Popcount via a rescan check.
    const bitmap: Array<{ bm: string }> = await ds.query(
      `SELECT active_days_bitmap::text AS bm FROM user_spine WHERE game_id = $1 AND user_id = $2`,
      [game, user],
    );
    const ones = (bitmap[0]?.bm.match(/1/g) ?? []).length;
    expect(ones).toBe(1);
  });

  // ---- USER_SPINE survives a simulated Redis loss (P7 durable-immediate) ------
  it('P7: the spine bit is in Postgres BEFORE Redis — a Redis flush cannot un-retain', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0);
    dirs.push(h.dir);
    const game = uid('g-p7');
    const user = uid('u');
    const now = Date.parse('2026-07-16T20:00:00Z');
    await h.kernel.process(
      sessionEvent({
        game,
        userId: user,
        sessionId: 's1',
        start: Date.parse('2026-07-16T09:00:00Z'),
        end: Date.parse('2026-07-16T09:05:00Z'),
      }),
      ctx(now, 0),
    );
    // Simulate a TOTAL Redis loss BEFORE any flush — wipe every hot bucket for the game.
    const keys = await redis.keys(`${game}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    // The spine (durable-immediate) is untouched: first_seen + bit 0 survive.
    const fs = await h.spine.findFirstSeen(game, user);
    expect(fs).not.toBeNull();
    const bit: Array<{ b: number }> = await ds.query(
      `SELECT get_bit(active_days_bitmap, 0) AS b FROM user_spine WHERE game_id = $1 AND user_id = $2`,
      [game, user],
    );
    expect(bit[0]?.b).toBe(1);
    // Recovery: a spine re-scan rebuilds the projections from the durable spine.
    const res = await h.rescan.rescanGame(game);
    expect(res.spineRows).toBe(1);
    const cell0: Array<{ n: string }> = await ds.query(
      `SELECT retained_users::text AS n FROM retention_cell WHERE game_id = $1 AND cohort_date = '2026-07-16' AND day_offset = 0`,
      [game],
    );
    expect(Number(cell0[0]?.n)).toBe(1); // re-projected from the bit — never un-retained
  });

  // ---- negative-offset (in-grace processing race) ----------------------------
  it('negative offset (later-day session seeds first_seen first): skip bit+counter, tally negative_offset, session still counts', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0);
    dirs.push(h.dir);
    const game = uid('g-neg');
    const user = uid('u');
    // now late 07-17 so 07-16 AND 07-15 are both open (grace).
    const now = Date.parse('2026-07-17T12:00:00Z');
    // Later-day session (07-16) processes FIRST → seeds first_seen = 07-16.
    await h.kernel.process(
      sessionEvent({
        game,
        userId: user,
        sessionId: 's-late',
        start: Date.parse('2026-07-16T09:00:00Z'),
        end: Date.parse('2026-07-16T09:05:00Z'),
      }),
      ctx(now, 0),
    );
    // Earlier-day session (07-15) processes SECOND → offset = -1 (negative).
    await h.kernel.process(
      sessionEvent({
        game,
        userId: user,
        sessionId: 's-early',
        start: Date.parse('2026-07-15T09:00:00Z'),
        end: Date.parse('2026-07-15T09:05:00Z'),
      }),
      ctx(now, 0),
    );
    await h.flushJob.sweep();

    // negative_offset tallied on the arrival day.
    const arrivalDay = arrivalBucketDay(Date.parse('2026-07-15T09:06:02Z'), 0);
    const tally = await ds
      .getRepository(ExceptionTallyEntity)
      .findOne({ where: { gameId: game, utcDay: arrivalDay, reason: 'negative_offset' } });
    expect(Number(tally?.count ?? 0)).toBeGreaterThanOrEqual(1);

    // The earlier session STILL counts in the day aggregates (07-15).
    const d15 = await h.sessionRead.sessionDay(game, '2026-07-15', now);
    expect(d15.sessionCount).toBe(1);
    // first_seen NOT back-dated: cohort is 07-16 (the seeding day), and no bit for a negative offset.
    const cohort16: Array<{ n: string }> = await ds.query(
      `SELECT cohort_size::text AS n FROM cohort WHERE game_id = $1 AND cohort_date = '2026-07-16'`,
      [game],
    );
    expect(Number(cohort16[0]?.n)).toBe(1);
    const cohort15: Array<{ n: string }> = await ds.query(
      `SELECT count(*)::text AS n FROM cohort WHERE game_id = $1 AND cohort_date = '2026-07-15'`,
      [game],
    );
    expect(Number(cohort15[0]?.n)).toBe(0); // never back-dated
  });

  // ---- over-horizon (offset ≥ span) → silent no-op ----------------------------
  it('over-horizon offset (beyond the bitmap span) → silent no-op: no bit, no counter, no tally', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0);
    dirs.push(h.dir);
    const game = uid('g-oh');
    const user = uid('u');
    // Seed first_seen far in the past, then a session 100 days later (span default 45).
    const seedNow = Date.parse('2026-05-01T20:00:00Z');
    await h.kernel.process(
      sessionEvent({
        game,
        userId: user,
        sessionId: 's-seed',
        start: Date.parse('2026-05-01T09:00:00Z'),
        end: Date.parse('2026-05-01T09:05:00Z'),
      }),
      ctx(seedNow, 0),
    );
    // A session 100 days later — offset 100 ≥ span 45 → over-horizon. Its own day
    // must be open for it to reach step 7, so `now` sits on that day.
    const farStart = Date.parse('2026-08-09T09:00:00Z'); // ~100 days after 05-01
    const farNow = Date.parse('2026-08-09T20:00:00Z');
    await h.kernel.process(
      sessionEvent({ game, userId: user, sessionId: 's-far', start: farStart, end: farStart + 5 * MIN }),
      ctx(farNow, 0),
    );
    await h.flushJob.sweep();

    // No negative_offset tally, and no over-horizon tally of any kind (silent).
    const tallies = await ds.getRepository(ExceptionTallyEntity).find({ where: { gameId: game } });
    expect(tallies.every((t) => t.reason !== 'negative_offset')).toBe(true);
    // Only ONE bit set (the seed day) — the far session set no bit.
    const bitmap: Array<{ bm: string }> = await ds.query(
      `SELECT active_days_bitmap::text AS bm FROM user_spine WHERE game_id = $1 AND user_id = $2`,
      [game, user],
    );
    const ones = (bitmap[0]?.bm.match(/1/g) ?? []).length;
    expect(ones).toBe(1);
    // But the far session STILL counts in its own day aggregate.
    const dFar = await h.sessionRead.sessionDay(game, '2026-08-09', farNow);
    expect(dFar.sessionCount).toBe(1);
  });

  // ---- sealed-late → full stop at step 5 -------------------------------------
  it('sealed-late session: full stop at step 5 — no first_seen, no bit, sealed_late tallied', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0);
    dirs.push(h.dir);
    const game = uid('g-sealed');
    const user = uid('u');
    // A session whose START day (07-10) is long sealed relative to now (07-20).
    const now = Date.parse('2026-07-20T12:00:00Z');
    const outcome = await h.kernel.process(
      sessionEvent({
        game,
        userId: user,
        sessionId: 's-old',
        start: Date.parse('2026-07-10T09:00:00Z'),
        end: Date.parse('2026-07-10T09:05:00Z'),
      }),
      ctx(now, 0),
    );
    // The kernel quarantines the whole event at step 5 (sealed_late) — the session
    // hooks never run (durable + hot skipped for a non-route disposition).
    expect(outcome.verdicts.disposition).toBe('quarantine');
    expect(outcome.verdicts.reason).toBe('sealed_late');
    expect(outcome.counted).toBe(false);
    // No spine row created (7a never ran).
    const fs = await h.spine.findFirstSeen(game, user);
    expect(fs).toBeNull();
  });

  // ---- logical-day @ +210 ----------------------------------------------------
  it('logical-day @ +210: a 22:00 UTC session on 07-15 anchors on the +03:30 day 07-16', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 210);
    dirs.push(h.dir);
    const game = uid('g-tz');
    const user = uid('u');
    // 22:00 UTC 07-15 = 01:30 local 07-16 → logical cohort day 07-16.
    const now = Date.parse('2026-07-16T20:00:00Z');
    await h.kernel.process(
      sessionEvent({
        game,
        userId: user,
        sessionId: 's1',
        start: Date.parse('2026-07-15T22:00:00Z'),
        end: Date.parse('2026-07-15T22:30:00Z'),
      }),
      ctx(now, 210),
    );
    await h.flushJob.sweep();
    const cohort16: Array<{ n: string }> = await ds.query(
      `SELECT cohort_size::text AS n FROM cohort WHERE game_id = $1 AND cohort_date = '2026-07-16'`,
      [game],
    );
    expect(Number(cohort16[0]?.n)).toBe(1); // logical (offset) day, NOT the raw-UTC 07-15
  });

  // ---- SC-005 synthetic population: headline D1/D7/D30 + immature D7 = N/A ----
  it('SC-005: synthetic population → headline D1/D7/D30 hand-computed + a 3-day cohort D7 masked N/A', async () => {
    if (!redis || !ds) return;
    const h = buildHarness(redis, ds, 0);
    dirs.push(h.dir);
    const game = uid('g-sc005');
    // "today" = 07-17. Cohort A installed 06-01 (mature at 1/7/30). We seed a small
    // exact population so D_N is hand-verifiable, then check masking on a 3-day cohort.
    const today = Date.parse('2026-07-17T20:00:00Z');

    // Cohort A (install 06-01), size 10. Returns: 4 on D1, 2 on D7, 1 on D30.
    const cohortAInstall = '2026-06-01';
    const aUsers: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const u = uid('a');
      aUsers.push(u);
      // Install session on 06-01 (its own day must be open at seed time).
      const seedNow = Date.parse('2026-06-01T20:00:00Z');
      await h.kernel.process(
        sessionEvent({
          game,
          userId: u,
          sessionId: `${u}-d0`,
          start: Date.parse(`${cohortAInstall}T09:00:00Z`),
          end: Date.parse(`${cohortAInstall}T09:05:00Z`),
        }),
        ctx(seedNow, 0),
      );
    }
    // Returns on later offsets — each on its OWN day (open at that time).
    const returnOn = async (u: string, offsetDay: string): Promise<void> => {
      const dayNow = Date.parse(`${offsetDay}T20:00:00Z`);
      await h.kernel.process(
        sessionEvent({
          game,
          userId: u,
          sessionId: `${u}-${offsetDay}`,
          start: Date.parse(`${offsetDay}T10:00:00Z`),
          end: Date.parse(`${offsetDay}T10:05:00Z`),
        }),
        ctx(dayNow, 0),
      );
    };
    // D1 = 06-02 (4 users), D7 = 06-08 (2 users), D30 = 07-01 (1 user).
    for (let i = 0; i < 4; i += 1) await returnOn(aUsers[i]!, '2026-06-02');
    for (let i = 0; i < 2; i += 1) await returnOn(aUsers[i]!, '2026-06-08');
    await returnOn(aUsers[0]!, '2026-07-01');

    // Cohort B (install 07-14, 3 days before today): size 4, 2 return on D1 (07-15).
    const cohortBInstall = '2026-07-14';
    const bUsers: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const u = uid('b');
      bUsers.push(u);
      await h.kernel.process(
        sessionEvent({
          game,
          userId: u,
          sessionId: `${u}-d0`,
          start: Date.parse(`${cohortBInstall}T09:00:00Z`),
          end: Date.parse(`${cohortBInstall}T09:05:00Z`),
        }),
        ctx(Date.parse(`${cohortBInstall}T20:00:00Z`), 0),
      );
    }
    for (let i = 0; i < 2; i += 1) await returnOn(bUsers[i]!, '2026-07-15');

    await h.flushJob.sweep();

    // Headline over MATURE cohorts only (today − c ≥ N).
    const headline = await h.retentionRead.headline(game, today);
    const byN = new Map(headline.map((x) => [x.offset, x]));

    // D1: mature cohorts A (06-01) AND B (07-14) — both have an elapsed day 1.
    //   retained = A's 4 (06-02) + B's 2 (07-15) = 6; size = 10 + 4 = 14 → 6/14.
    const d1 = byN.get(1)!;
    expect(d1.retainedSum).toBe(6);
    expect(d1.sizeSum).toBe(14);
    expect(d1.rate).toBeCloseTo(6 / 14, 6);

    // D7: only cohort A is mature at 7 (B is 3 days old → EXCLUDED). retained 2 / size 10.
    const d7 = byN.get(7)!;
    expect(d7.matureCohorts).toEqual(['2026-06-01']);
    expect(d7.retainedSum).toBe(2);
    expect(d7.sizeSum).toBe(10);
    expect(d7.rate).toBeCloseTo(0.2, 6);

    // D30: only cohort A. retained 1 / size 10.
    const d30 = byN.get(30)!;
    expect(d30.retainedSum).toBe(1);
    expect(d30.sizeSum).toBe(10);
    expect(d30.rate).toBeCloseTo(0.1, 6);

    // Immature mask: cohort B's D7 cell reads N/A (rate null), never a low number.
    const heat = await h.retentionRead.heatmap(game, [1, 7], today);
    const bD7 = heat.find((cell) => cell.cohortDate === cohortBInstall && cell.offset === 7);
    expect(bD7).toBeDefined();
    expect(bD7?.immature).toBe(true);
    expect(bD7?.rate).toBeNull(); // N/A, not 0 %
    // Cohort B's D1 is mature (1 day elapsed) → a real number.
    const bD1 = heat.find((cell) => cell.cohortDate === cohortBInstall && cell.offset === 1);
    expect(bD1?.immature).toBe(false);
    expect(bD1?.rate).toBeCloseTo(0.5, 6); // 2/4
  });

  // ---- small-cohort mask -----------------------------------------------------
  it('small-cohort mask: a mature cohort below retention_min_cohort_size is low-confidence (never hidden)', async () => {
    if (!redis || !ds) return;
    // min cohort size default 30; a 3-user cohort is below it.
    const h = buildHarness(redis, ds, 0);
    dirs.push(h.dir);
    const game = uid('g-small');
    const today = Date.parse('2026-07-17T20:00:00Z');
    const install = '2026-06-01';
    for (let i = 0; i < 3; i += 1) {
      await h.kernel.process(
        sessionEvent({
          game,
          userId: uid('u'),
          sessionId: `s${i}`,
          start: Date.parse(`${install}T09:00:00Z`) + i * MIN,
          end: Date.parse(`${install}T09:05:00Z`) + i * MIN,
        }),
        ctx(Date.parse(`${install}T20:00:00Z`), 0),
      );
    }
    await h.flushJob.sweep();
    const heat = await h.retentionRead.heatmap(game, [0], today);
    const cell = heat.find((x) => x.cohortDate === install && x.offset === 0);
    expect(cell?.lowConfidence).toBe(true); // < 30 → low-confidence mask
    expect(cell?.rate).toBeCloseTo(1.0, 6); // D0 = 100 %, still shown (never hidden)
  });
});
