/**
 * REAL (cross-story) erasure/DSAR spine-family port implementations.
 *
 * The three interfaces in {@link ./erasure.ports} are the seam 002 OWNS but
 * DELEGATES; the four-tier posture (Q7) deletes structures owned by LATER specs
 * (003 `USER_SPINE`/`ACTIVE_USER_DAY`, 004 `BALANCE_SNAPSHOT`, 006/007 `PAYER_*`
 * + `PURCHASE_IDEMPOTENCY`). This module binds those ports to real bitmap reads
 * + spine-family deletes against the seven live spine tables — the concrete
 * implementations the port docstring said later specs MUST provide + rebind.
 *
 * Erasure op-order (ops-envelope §7, enforced by ErasureService, not here):
 *   1. read spine days FIRST (SpineEnumerationPort — bitmap read before delete);
 *   2. any unsealed day → park awaiting_seal;
 *   3. destructive pass (TierADeletionPort) only once ALL enumerated days sealed.
 *
 * Tier scope: tier (a) = the seven per-user spine-family tables (HARD-DELETE, or
 * for PURCHASE_IDEMPOTENCY a user_id DETACH). Tier (b) aggregate cells
 * (EVENT_DAY_COUNT / EVENT_CATALOG / EXCEPTION_TALLY / MONETIZATION_CELL) are
 * LEFT UNTOUCHED by design — anonymous once user_id is detached (§7.1). We never
 * reference them here.
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GameConfigService, GAME_CONFIG_DEFAULTS } from '../config/game-config.service';
import { logicalDay } from '../common/kernel/logical-day';
import { checkSealState } from '../common/kernel/seal';
import type { SpineEnumerationPort, TierADeletionPort, DsarExportPort } from './erasure.ports';

const MS_PER_DAY = 24 * 60 * 60_000;
const MS_PER_MINUTE = 60_000;

/**
 * Non-identifying tombstone sentinel written into `purchase_idempotency.user_id`
 * under `purchaseMode: 'detach'`. The column is NOT NULL text and is neither the
 * PK (that is `transaction_id`) nor part of any unique key, so overwriting it
 * with a fixed marker preserves the money-dedup slot + revenue aggregates while
 * severing the PII link — no schema change (no nullable migration) needed.
 */
export const PURCHASE_ERASED_SENTINEL = '__erased__';

/**
 * Platform reporting offset (minutes, Foundation §4.7). Read straight from
 * `process.env.REPORTING_OFFSET` — coerced to a safe integer, UTC (0) on
 * anything unparseable — mirroring SessionConfigService so the seal clock here
 * and the ingest/seal clock elsewhere never diverge. (We do NOT depend on
 * SessionsModule; the GDPR context stays self-contained.)
 */
function reportingOffsetMinutes(): number {
  const raw = process.env.REPORTING_OFFSET;
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(n) ? n : 0;
}

/** Add `n` calendar days to a `YYYY-MM-DD` string (UTC-anchored). */
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Map a logical-day string (`YYYY-MM-DD`, offset-local calendar day) to a UTC
 * epoch-ms strictly inside that logical day, so {@link checkSealState} computes
 * `D_end + grace` for exactly that day (its UTC start is `parse(D) − offset`;
 * +1 ms lands strictly inside D). Same idiom as the cold-storage seal check.
 */
function logicalDayInstant(day: string, offsetMinutes: number): number {
  return Date.parse(`${day}T00:00:00Z`) - offsetMinutes * MS_PER_MINUTE + 1;
}

/**
 * REAL spine day-enumeration port. Enumerates every distinct logical day the
 * subject was active/paying, and whether ALL of them are already sealed.
 *
 * Days are the UNION of:
 *   - `USER_SPINE.active_days_bitmap` — cohort = logical_day(first_seen); each set
 *     bit at offset N → cohort + N days (same decode as SpineRescanService);
 *   - `ACTIVE_USER_DAY.utc_day` where the subject is in the `members` jsonb set;
 *   - `PAYER_DAY.utc_day` where the subject is in the `payer_members` jsonb set;
 *   - `PURCHASE_IDEMPOTENCY.purchase_day` for the subject.
 *
 * `allSealed` = true iff every enumerated day is sealed (`D_end + grace` passed).
 * No spine rows anywhere → `{days:[], allSealed:true}` (nothing to wait on — the
 * destructive pass may proceed immediately, matching the 002 no-op posture).
 */
@Injectable()
export class SpineEnumerationPortImpl implements SpineEnumerationPort {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(GameConfigService) private readonly gameConfig: GameConfigService,
  ) {}

  async enumerateDays(gameId: string, userId: string): Promise<{ days: string[]; allSealed: boolean }> {
    const offsetMinutes = reportingOffsetMinutes();
    const days = new Set<string>();

    // USER_SPINE — decode the set bits relative to the cohort (first_seen day).
    const spineRows: Array<{ first_seen: Date | string; active_days_bitmap: string }> = await this.dataSource.query(
      `SELECT first_seen, active_days_bitmap FROM user_spine WHERE game_id = $1 AND user_id = $2`,
      [gameId, userId],
    );
    for (const row of spineRows) {
      const firstSeenMs =
        row.first_seen instanceof Date ? row.first_seen.getTime() : Date.parse(String(row.first_seen));
      const cohortDate = logicalDay(firstSeenMs, offsetMinutes);
      const bitmap = String(row.active_days_bitmap ?? '');
      for (let offset = 0; offset < bitmap.length; offset += 1) {
        if (bitmap[offset] === '1') {
          days.add(addDays(cohortDate, offset));
        }
      }
    }

    // ACTIVE_USER_DAY — days whose exact member set contains the subject.
    const activeRows: Array<{ utc_day: string }> = await this.dataSource.query(
      `SELECT utc_day::text AS utc_day FROM active_user_day WHERE game_id = $1 AND members ? $2`,
      [gameId, userId],
    );
    for (const r of activeRows) {
      days.add(r.utc_day);
    }

    // PAYER_DAY — days whose payer member set contains the subject.
    const payerRows: Array<{ utc_day: string }> = await this.dataSource.query(
      `SELECT utc_day::text AS utc_day FROM payer_day WHERE game_id = $1 AND payer_members ? $2`,
      [gameId, userId],
    );
    for (const r of payerRows) {
      days.add(r.utc_day);
    }

    // PURCHASE_IDEMPOTENCY — the subject's purchase days.
    const purchaseRows: Array<{ purchase_day: string }> = await this.dataSource.query(
      `SELECT DISTINCT purchase_day::text AS purchase_day FROM purchase_idempotency WHERE game_id = $1 AND user_id = $2`,
      [gameId, userId],
    );
    for (const r of purchaseRows) {
      days.add(r.purchase_day);
    }

    const dayList = [...days].sort();
    if (dayList.length === 0) {
      // Nothing to wait on — vacuously all-sealed (same as the 002 no-op).
      return { days: [], allSealed: true };
    }

    const graceHours =
      (await this.gameConfig.getNumber(gameId, 'day_seal_grace_hours')) ?? GAME_CONFIG_DEFAULTS.day_seal_grace_hours;
    const graceWindowMs = graceHours * 60 * 60_000;
    const now = Date.now();
    const allSealed = dayList.every(
      (day) =>
        checkSealState({
          correctedTime: logicalDayInstant(day, offsetMinutes),
          now,
          reportingOffsetMinutes: offsetMinutes,
          graceWindowMs,
        }) === 'sealed',
    );

    return { days: dayList, allSealed };
  }
}

/**
 * REAL tier-(a) destructive port. HARD-DELETEs the subject's rows across the six
 * pure per-user spine tables and DETACHes (or, under `purchaseMode: 'delete'`,
 * HARD-DELETEs) the money-dedup table, all in ONE transaction. Idempotent:
 * absent rows → 0 affected, no error.
 *
 * `PURCHASE_IDEMPOTENCY` handling:
 *   - `'detach'` (DEFAULT) — overwrite `user_id` with {@link PURCHASE_ERASED_SENTINEL}
 *     (only rows not already tombstoned, so re-runs affect 0). The dedup key
 *     (`transaction_id`) and the money row survive, so revenue aggregates stay
 *     correct and a replayed offline purchase still dedupes — the PII link is gone.
 *   - `'delete'` — HARD-DELETE the subject's rows (operator accepts the §F
 *     double-count-on-replay risk).
 *
 * Aggregate cells (EVENT_DAY_COUNT / EVENT_CATALOG / EXCEPTION_TALLY / PAYER_DAY
 * totals / MONETIZATION_CELL) are LEFT UNTOUCHED (tier b) — never referenced here.
 * Note PAYER_DAY.payer_members / ACTIVE_USER_DAY.members are per-user membership
 * SETS, not anonymous aggregates — but they are rebuildable projections of the
 * spine/purchase floor, which this pass deletes; leaving the stale membership key
 * is the documented reconcile-forward posture (T-00.77: stored sealed cells are
 * post-erasure truth, re-derived on the next rebuild). We do NOT surgically edit
 * sealed membership sets here (that would mutate a sealed cell).
 */
@Injectable()
export class TierADeletionPortImpl implements TierADeletionPort {
  constructor(private readonly dataSource: DataSource) {}

  async deleteSpineFamily(input: {
    gameId: string;
    userId: string;
    days: string[];
    purchaseMode: 'detach' | 'delete';
  }): Promise<void> {
    const { gameId, userId, purchaseMode } = input;
    await this.dataSource.transaction(async (tx) => {
      // Six pure per-user spine tables — HARD-DELETE by (game_id, user_id).
      await tx.query(`DELETE FROM user_spine WHERE game_id = $1 AND user_id = $2`, [gameId, userId]);
      await tx.query(`DELETE FROM balance_snapshot WHERE game_id = $1 AND user_id = $2`, [gameId, userId]);
      await tx.query(`DELETE FROM payer_spine_ext WHERE game_id = $1 AND user_id = $2`, [gameId, userId]);
      await tx.query(`DELETE FROM payer_period_spend WHERE game_id = $1 AND user_id = $2`, [gameId, userId]);

      // ACTIVE_USER_DAY / PAYER_DAY are day-keyed membership SETS keyed
      // (game_id, utc_day) — the subject is a jsonb key. Strip the subject key
      // from the set (keeping the day cell) so the membership no longer
      // identifies, without deleting the whole day's aggregate row.
      await tx.query(`UPDATE active_user_day SET members = members - $3 WHERE game_id = $1 AND members ? $2`, [
        gameId,
        userId,
        userId,
      ]);
      await tx.query(
        `UPDATE payer_day SET payer_members = payer_members - $3 WHERE game_id = $1 AND payer_members ? $2`,
        [gameId, userId, userId],
      );

      // PURCHASE_IDEMPOTENCY — detach (tombstone user_id) or delete.
      if (purchaseMode === 'delete') {
        await tx.query(`DELETE FROM purchase_idempotency WHERE game_id = $1 AND user_id = $2`, [gameId, userId]);
      } else {
        await tx.query(
          `UPDATE purchase_idempotency SET user_id = $3 WHERE game_id = $1 AND user_id = $2 AND user_id <> $3`,
          [gameId, userId, PURCHASE_ERASED_SENTINEL],
        );
      }
    });
  }
}

/**
 * REAL DSAR (Art. 15/20) export-assembly port. Read-only assembly of the
 * subject's spine-family data into a machine-readable object. Empty subject →
 * empty sections (NOT the 002 placeholder note). This is THEIR data being
 * returned to them, so their own user_id / purchases are in scope.
 */
@Injectable()
export class DsarExportPortImpl implements DsarExportPort {
  constructor(private readonly dataSource: DataSource) {}

  async assembleSpineExport(gameId: string, userId: string): Promise<Record<string, unknown>> {
    const offsetMinutes = reportingOffsetMinutes();

    // USER_SPINE + decoded active days.
    const spineRows: Array<{ first_seen: Date | string; active_days_bitmap: string }> = await this.dataSource.query(
      `SELECT first_seen, active_days_bitmap FROM user_spine WHERE game_id = $1 AND user_id = $2`,
      [gameId, userId],
    );
    const spine = spineRows[0]
      ? (() => {
          const firstSeenMs =
            spineRows[0]!.first_seen instanceof Date
              ? spineRows[0]!.first_seen.getTime()
              : Date.parse(String(spineRows[0]!.first_seen));
          const cohortDate = logicalDay(firstSeenMs, offsetMinutes);
          const bitmap = String(spineRows[0]!.active_days_bitmap ?? '');
          const activeDays: string[] = [];
          for (let offset = 0; offset < bitmap.length; offset += 1) {
            if (bitmap[offset] === '1') {
              activeDays.push(addDays(cohortDate, offset));
            }
          }
          return {
            first_seen: new Date(firstSeenMs).toISOString(),
            cohort_day: cohortDate,
            active_days: activeDays,
          };
        })()
      : null;

    // ACTIVE_USER_DAY membership (projection of the bitmap; included for completeness).
    const activeMembershipRows: Array<{ utc_day: string }> = await this.dataSource.query(
      `SELECT utc_day::text AS utc_day FROM active_user_day WHERE game_id = $1 AND members ? $2 ORDER BY utc_day`,
      [gameId, userId],
    );

    // BALANCE_SNAPSHOT — per-currency last-known balance.
    const balanceRows: Array<{
      currency: string;
      last_known_balance: string;
      as_of: Date | string;
      provenance: string;
    }> = await this.dataSource.query(
      `SELECT currency, last_known_balance, as_of, provenance FROM balance_snapshot WHERE game_id = $1 AND user_id = $2 ORDER BY currency`,
      [gameId, userId],
    );

    // PAYER_SPINE_EXT — payer profile.
    const payerExtRows: Array<{
      first_purchase_day: string;
      lifetime_spend_normalized: string;
      has_unconverted_spend: boolean;
    }> = await this.dataSource.query(
      `SELECT first_purchase_day::text AS first_purchase_day, lifetime_spend_normalized, has_unconverted_spend
         FROM payer_spine_ext WHERE game_id = $1 AND user_id = $2`,
      [gameId, userId],
    );

    // PAYER_PERIOD_SPEND — per-period cumulative spend.
    const periodRows: Array<{ period: string; spend_normalized: string }> = await this.dataSource.query(
      `SELECT period, spend_normalized FROM payer_period_spend WHERE game_id = $1 AND user_id = $2 ORDER BY period`,
      [gameId, userId],
    );

    // PAYER_DAY membership (subject appears as a payer that day).
    const payerDayRows: Array<{ utc_day: string }> = await this.dataSource.query(
      `SELECT utc_day::text AS utc_day FROM payer_day WHERE game_id = $1 AND payer_members ? $2 ORDER BY utc_day`,
      [gameId, userId],
    );

    // PURCHASE_IDEMPOTENCY — the subject's purchases.
    const purchaseRows: Array<{
      transaction_id: string;
      original_transaction_id: string;
      purchase_day: string;
      price_local: string;
      currency: string;
      product_id: string;
      refunded: boolean;
    }> = await this.dataSource.query(
      `SELECT transaction_id, original_transaction_id, purchase_day::text AS purchase_day, price_local, currency, product_id, refunded
         FROM purchase_idempotency WHERE game_id = $1 AND user_id = $2 ORDER BY purchase_day, transaction_id`,
      [gameId, userId],
    );

    return {
      user_spine: spine,
      active_user_days: activeMembershipRows.map((r) => r.utc_day),
      balances: balanceRows.map((r) => ({
        currency: r.currency,
        last_known_balance: r.last_known_balance,
        as_of: r.as_of instanceof Date ? r.as_of.toISOString() : new Date(String(r.as_of)).toISOString(),
        provenance: r.provenance,
      })),
      payer_profile: payerExtRows[0]
        ? {
            first_purchase_day: payerExtRows[0].first_purchase_day,
            lifetime_spend_normalized: payerExtRows[0].lifetime_spend_normalized,
            has_unconverted_spend: payerExtRows[0].has_unconverted_spend,
          }
        : null,
      payer_days: payerDayRows.map((r) => r.utc_day),
      period_spend: periodRows.map((r) => ({ period: r.period, spend_normalized: r.spend_normalized })),
      purchases: purchaseRows.map((r) => ({
        transaction_id: r.transaction_id,
        original_transaction_id: r.original_transaction_id,
        purchase_day: r.purchase_day,
        price_local: r.price_local,
        currency: r.currency,
        product_id: r.product_id,
        refunded: r.refunded,
      })),
    };
  }
}
