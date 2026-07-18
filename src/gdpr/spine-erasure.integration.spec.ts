/**
 * REAL spine-family erasure + DSAR against LIVE Postgres (P13 / Art.17 + Art.15).
 *
 * The 002-scope integration spec proves IDENTITY_EDGE deletion with the no-op
 * ports; THIS spec proves the cross-story bug fix — the REAL ports actually
 * delete/detach the seven per-user spine tables and the DSAR export returns the
 * subject's real spine data. Skips when the stack is unreachable.
 *
 * Proves:
 *  1. erasure deletes ALL seven spine tables (detach keeps the money-dedup row);
 *  2. awaiting_seal gate: an UNSEALED active day blocks the destructive pass and
 *     NOTHING is deleted; sealing + re-run then executes and deletes;
 *  3. detach vs delete purchaseMode for PURCHASE_IDEMPOTENCY;
 *  4. idempotent re-run is a no-op (still executed, no error);
 *  5. DSAR returns the subject's real spine data (non-placeholder); empty subject
 *     → empty sections (no placeholder note);
 *  6. isolation (P12): erasing (gameA,user1) does NOT touch (gameB,user1).
 */

import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { connectPostgresOrNull } from '../testing/live-infra';
import { ErasureService } from './erasure.service';
import { DsarService } from './dsar.service';
import { SubjectHashService } from '../security/subject-hash.service';
import { ErasureLedgerEntity } from '../database/entities/erasure-ledger.entity';
import { IdentityEdgeEntity } from '../database/entities/identity-edge.entity';
import { ActiveUserDayEntity } from '../database/entities/active-user-day.entity';
import { BalanceSnapshotEntity } from '../database/entities/balance-snapshot.entity';
import { PayerSpineExtEntity } from '../database/entities/payer-spine-ext.entity';
import { PayerDayEntity } from '../database/entities/payer-day.entity';
import { PayerPeriodSpendEntity } from '../database/entities/payer-period-spend.entity';
import { PurchaseIdempotencyEntity } from '../database/entities/purchase-idempotency.entity';
import type { GameConfigService } from '../config/game-config.service';
import {
  SpineEnumerationPortImpl,
  TierADeletionPortImpl,
  DsarExportPortImpl,
  PURCHASE_ERASED_SENTINEL,
} from './spine-erasure.ports';

const cfg = { get: () => 'live-test-master' } as unknown as ConfigService;
// getNumber('day_seal_grace_hours') → undefined ⇒ port falls back to the 48h default.
const gameConfig = {
  getString: async () => undefined,
  getNumber: async () => undefined,
} as unknown as GameConfigService;

const MS_PER_DAY = 24 * 60 * 60_000;

/** A logical day string N days before today (UTC; offset 0 in test env). */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * MS_PER_DAY).toISOString().slice(0, 10);
}

describe('REAL spine-family erasure + DSAR (live Postgres)', () => {
  let ds: DataSource | null = null;
  let subjectHash: SubjectHashService;
  const GAME = `spine-erase-${Math.random().toString(36).slice(2)}`;
  const OTHER_GAME = `spine-erase-other-${Math.random().toString(36).slice(2)}`;
  const USER = 'subject-user-1';
  const OTHER_USER = 'bystander-user-2';

  // A SEALED day (10 days ago is well past D_end + 48h) and an UNSEALED day (today).
  const SEALED_DAY = daysAgo(10);
  const TODAY = new Date().toISOString().slice(0, 10);

  async function makeErasure(): Promise<ErasureService> {
    return new ErasureService(
      ds!,
      subjectHash,
      gameConfig,
      new SpineEnumerationPortImpl(ds!, gameConfig),
      new TierADeletionPortImpl(ds!),
    );
  }

  async function makeErasureDelete(): Promise<ErasureService> {
    const deleteMode = {
      getString: async () => 'delete',
      getNumber: async () => undefined,
    } as unknown as GameConfigService;
    return new ErasureService(
      ds!,
      subjectHash,
      deleteMode,
      new SpineEnumerationPortImpl(ds!, deleteMode),
      new TierADeletionPortImpl(ds!),
    );
  }

  /** Seed a subject with rows in ALL seven spine tables on the given day. */
  async function seedSubject(gameId: string, userId: string, day: string, txId: string): Promise<void> {
    // USER_SPINE: first_seen = the seed day; bit 0 set (active on the cohort day).
    await ds!.query(
      `INSERT INTO user_spine (game_id, user_id, first_seen, active_days_bitmap)
       VALUES ($1, $2, $3, B'1'::bit varying)
       ON CONFLICT (game_id, user_id) DO NOTHING`,
      [gameId, userId, new Date(`${day}T00:00:00Z`)],
    );
    await ds!.getRepository(ActiveUserDayEntity).save({ gameId, utcDay: day, members: { [userId]: true } });
    await ds!.getRepository(BalanceSnapshotEntity).save({
      gameId,
      userId,
      currency: 'gold',
      lastKnownBalance: '500',
      asOf: new Date(`${day}T00:00:00Z`),
      provenance: 'seed',
    });
    await ds!.getRepository(PayerSpineExtEntity).save({
      gameId,
      userId,
      firstPurchaseDay: day,
      lifetimeSpendNormalized: '9.99',
      hasUnconvertedSpend: false,
    });
    await ds!.getRepository(PayerDayEntity).save({
      gameId,
      utcDay: day,
      payerMembers: { [userId]: true },
      revenueDayTotal: '9.99',
      gen: 0,
    });
    await ds!.getRepository(PayerPeriodSpendEntity).save({
      gameId,
      period: day.slice(0, 7),
      userId,
      spendNormalized: '9.99',
    });
    await ds!.getRepository(PurchaseIdempotencyEntity).save({
      transactionId: txId,
      originalTransactionId: txId,
      gameId,
      userId,
      purchaseDay: day,
      priceLocal: '9.99',
      currency: 'USD',
      productId: 'sku.gems.100',
      refunded: false,
    });
  }

  async function spineRowCounts(gameId: string, userId: string) {
    const one = async (sql: string): Promise<number> => {
      const rows: Array<{ n: string }> = await ds!.query(sql, [gameId, userId]);
      return Number(rows[0]?.n ?? 0);
    };
    return {
      userSpine: await one(`SELECT count(*)::text AS n FROM user_spine WHERE game_id = $1 AND user_id = $2`),
      activeMember: await one(`SELECT count(*)::text AS n FROM active_user_day WHERE game_id = $1 AND members ? $2`),
      balance: await one(`SELECT count(*)::text AS n FROM balance_snapshot WHERE game_id = $1 AND user_id = $2`),
      payerExt: await one(`SELECT count(*)::text AS n FROM payer_spine_ext WHERE game_id = $1 AND user_id = $2`),
      payerDayMember: await one(`SELECT count(*)::text AS n FROM payer_day WHERE game_id = $1 AND payer_members ? $2`),
      periodSpend: await one(`SELECT count(*)::text AS n FROM payer_period_spend WHERE game_id = $1 AND user_id = $2`),
      purchases: await one(`SELECT count(*)::text AS n FROM purchase_idempotency WHERE game_id = $1 AND user_id = $2`),
    };
  }

  beforeAll(async () => {
    ds = await connectPostgresOrNull();
    if (!ds) return;
    subjectHash = new SubjectHashService(cfg);
  });

  afterEach(async () => {
    if (!ds) return;
    for (const g of [GAME, OTHER_GAME]) {
      await ds.getRepository(ErasureLedgerEntity).delete({ gameId: g });
      await ds.getRepository(IdentityEdgeEntity).delete({ gameId: g });
      await ds.query(`DELETE FROM user_spine WHERE game_id = $1`, [g]);
      await ds.query(`DELETE FROM active_user_day WHERE game_id = $1`, [g]);
      await ds.query(`DELETE FROM balance_snapshot WHERE game_id = $1`, [g]);
      await ds.query(`DELETE FROM payer_spine_ext WHERE game_id = $1`, [g]);
      await ds.query(`DELETE FROM payer_day WHERE game_id = $1`, [g]);
      await ds.query(`DELETE FROM payer_period_spend WHERE game_id = $1`, [g]);
      await ds.query(`DELETE FROM purchase_idempotency WHERE game_id = $1`, [g]);
    }
  });

  afterAll(async () => {
    if (ds) await ds.destroy();
  });

  it('erasure HARD-DELETEs / detaches all seven spine tables (sealed day)', async () => {
    if (!ds) return;
    await seedSubject(GAME, USER, SEALED_DAY, 'tx-erase-1');
    await ds.getRepository(IdentityEdgeEntity).insert({
      gameId: GAME,
      anonId: 'anon-x',
      userId: USER,
      firstLinkedAt: new Date(),
    });

    const before = await spineRowCounts(GAME, USER);
    expect(before).toEqual({
      userSpine: 1,
      activeMember: 1,
      balance: 1,
      payerExt: 1,
      payerDayMember: 1,
      periodSpend: 1,
      purchases: 1,
    });

    const res = await (await makeErasure()).erase({ gameId: GAME, requestId: 'req-erase-1', userId: USER });
    expect(res.status).toBe('executed');
    expect(res.days).toContain(SEALED_DAY);

    const after = await spineRowCounts(GAME, USER);
    // All six pure/membership sources no longer identify the subject; purchases
    // are DETACHED (dedup row survives under a different user_id), so the
    // "purchases keyed to the subject" count is 0 too.
    expect(after).toEqual({
      userSpine: 0,
      activeMember: 0,
      balance: 0,
      payerExt: 0,
      payerDayMember: 0,
      periodSpend: 0,
      purchases: 0,
    });

    // DETACH: the dedup row + transaction_id survive, user_id tombstoned.
    const dedup: Array<{ transaction_id: string; user_id: string; price_local: string }> = await ds.query(
      `SELECT transaction_id, user_id, price_local FROM purchase_idempotency WHERE transaction_id = $1`,
      ['tx-erase-1'],
    );
    expect(dedup).toHaveLength(1);
    expect(dedup[0]!.user_id).toBe(PURCHASE_ERASED_SENTINEL);
    expect(dedup[0]!.price_local).toBe('9.990000'); // revenue survives

    // IDENTITY_EDGE gone; ledger executed with keyed-hash subject_ref.
    const edges = await ds.getRepository(IdentityEdgeEntity).find({ where: { gameId: GAME, userId: USER } });
    expect(edges).toHaveLength(0);
    const ledger = await ds
      .getRepository(ErasureLedgerEntity)
      .findOne({ where: { gameId: GAME, requestId: 'req-erase-1' } });
    expect(ledger!.status).toBe('executed');
    expect(ledger!.subjectRef).toBe(subjectHash.subjectRef(GAME, USER));
    expect(ledger!.subjectRef).not.toContain(USER);
  });

  it('awaiting_seal gate: unsealed active day blocks the destructive pass; nothing deleted, then seals + deletes', async () => {
    if (!ds) return;
    // Subject active on TODAY (unsealed) — the pass must NOT run.
    await seedSubject(GAME, USER, TODAY, 'tx-unsealed-1');

    const parked = await (await makeErasure()).erase({ gameId: GAME, requestId: 'req-seal-1', userId: USER });
    expect(parked.status).toBe('awaiting_seal');
    expect(parked.days).toContain(TODAY);

    // NOTHING deleted while parked.
    const still = await spineRowCounts(GAME, USER);
    expect(still.userSpine).toBe(1);
    expect(still.balance).toBe(1);
    expect(still.purchases).toBe(1);
    const dedupStill: Array<{ user_id: string }> = await ds.query(
      `SELECT user_id FROM purchase_idempotency WHERE transaction_id = $1`,
      ['tx-unsealed-1'],
    );
    expect(dedupStill[0]!.user_id).toBe(USER); // not detached

    // "Advance/seal": rewrite the subject's activity onto a SEALED day, re-run.
    await ds.query(`UPDATE user_spine SET first_seen = $3 WHERE game_id = $1 AND user_id = $2`, [
      GAME,
      USER,
      new Date(`${SEALED_DAY}T00:00:00Z`),
    ]);
    await ds.query(`UPDATE active_user_day SET members = members - $2 WHERE game_id = $1`, [GAME, USER]);
    await ds.getRepository(ActiveUserDayEntity).save({ gameId: GAME, utcDay: SEALED_DAY, members: { [USER]: true } });
    await ds.query(`UPDATE payer_day SET payer_members = payer_members - $2 WHERE game_id = $1`, [GAME, USER]);
    await ds
      .getRepository(PayerDayEntity)
      .save({ gameId: GAME, utcDay: SEALED_DAY, payerMembers: { [USER]: true }, revenueDayTotal: '9.99', gen: 0 });
    await ds.query(`UPDATE purchase_idempotency SET purchase_day = $2 WHERE transaction_id = $1`, [
      'tx-unsealed-1',
      SEALED_DAY,
    ]);

    const done = await (await makeErasure()).erase({ gameId: GAME, requestId: 'req-seal-1', userId: USER });
    expect(done.status).toBe('executed');
    const after = await spineRowCounts(GAME, USER);
    expect(after.userSpine).toBe(0);
    expect(after.purchases).toBe(0);
  });

  it('purchaseMode delete HARD-DELETEs the dedup row (vs detach which keeps it)', async () => {
    if (!ds) return;
    await seedSubject(GAME, USER, SEALED_DAY, 'tx-delete-1');

    await (await makeErasureDelete()).erase({ gameId: GAME, requestId: 'req-del-1', userId: USER });

    const dedup: Array<{ transaction_id: string }> = await ds.query(
      `SELECT transaction_id FROM purchase_idempotency WHERE transaction_id = $1`,
      ['tx-delete-1'],
    );
    expect(dedup).toHaveLength(0); // hard-deleted under 'delete' mode
  });

  it('idempotent — a second run stays executed, does not error, does not duplicate the ledger', async () => {
    if (!ds) return;
    await seedSubject(GAME, USER, SEALED_DAY, 'tx-idem-1');
    const svc = await makeErasure();
    const first = await svc.erase({ gameId: GAME, requestId: 'req-idem-1', userId: USER });
    expect(first.status).toBe('executed');

    const second = await svc.erase({ gameId: GAME, requestId: 'req-idem-1', userId: USER });
    expect(second.status).toBe('executed');
    const rows = await ds.getRepository(ErasureLedgerEntity).find({ where: { gameId: GAME, requestId: 'req-idem-1' } });
    expect(rows).toHaveLength(1);
  });

  it('DSAR returns the subject real spine data (non-placeholder); empty subject → empty sections', async () => {
    if (!ds) return;
    await seedSubject(GAME, USER, SEALED_DAY, 'tx-dsar-1');
    const dsar = new DsarService(ds, new DsarExportPortImpl(ds));

    const out = await dsar.assemble(GAME, USER);
    const spine = out.spine as Record<string, unknown>;
    expect(spine.note).toBeUndefined(); // NOT the 002 placeholder
    expect((spine.user_spine as { active_days: string[] }).active_days).toContain(SEALED_DAY);
    expect(spine.balances).toEqual([expect.objectContaining({ currency: 'gold', last_known_balance: '500' })]);
    expect((spine.payer_profile as { lifetime_spend_normalized: string }).lifetime_spend_normalized).toBe('9.990000');
    expect((spine.purchases as unknown[]).length).toBe(1);
    expect((spine.purchases as Array<{ transaction_id: string }>)[0]!.transaction_id).toBe('tx-dsar-1');

    // Empty subject → empty sections (no placeholder note).
    const empty = (await dsar.assemble(GAME, 'nobody-here')).spine as Record<string, unknown>;
    expect(empty.note).toBeUndefined();
    expect(empty.user_spine).toBeNull();
    expect(empty.balances).toEqual([]);
    expect(empty.purchases).toEqual([]);
    expect(empty.payer_profile).toBeNull();
  });

  it('isolation (P12): erasing (gameA,user) does NOT touch (gameB,same-user) or a bystander', async () => {
    if (!ds) return;
    await seedSubject(GAME, USER, SEALED_DAY, 'tx-iso-A');
    await seedSubject(OTHER_GAME, USER, SEALED_DAY, 'tx-iso-B'); // same user_id, different game
    await seedSubject(GAME, OTHER_USER, SEALED_DAY, 'tx-iso-bystander'); // same game, other user

    await (await makeErasure()).erase({ gameId: GAME, requestId: 'req-iso-1', userId: USER });

    // Target erased in GAME.
    expect((await spineRowCounts(GAME, USER)).userSpine).toBe(0);
    // Same user in OTHER_GAME untouched.
    const otherGame = await spineRowCounts(OTHER_GAME, USER);
    expect(otherGame.userSpine).toBe(1);
    expect(otherGame.purchases).toBe(1);
    // Bystander in the SAME game untouched.
    const bystander = await spineRowCounts(GAME, OTHER_USER);
    expect(bystander.userSpine).toBe(1);
    expect(bystander.purchases).toBe(1);
    // Bystander still a member of the shared day cell (his key survived the scrub).
    const bystanderMember: Array<{ n: string }> = await ds.query(
      `SELECT count(*)::text AS n FROM active_user_day WHERE game_id = $1 AND members ? $2`,
      [GAME, OTHER_USER],
    );
    expect(Number(bystanderMember[0]!.n)).toBe(1);
  });
});
