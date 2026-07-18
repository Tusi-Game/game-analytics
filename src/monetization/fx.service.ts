/**
 * FX service ([006-monetization] design step 8 FX, Q8, R9). Two responsibilities:
 *
 *  1. AS-OF LOOKUP + 3-WAY NORMALIZATION (hot path, reads the plaintext FX_RATE table):
 *     `rate = fx_rate(currency, purchase_day)` = the most recent FX_RATE row with
 *     `rate_date ≤ purchase_day`, valid iff `purchase_day − rate_date ≤
 *     fx_staleness_max_days`. Three outcomes:
 *       - fresh/valid rate (rate_date == purchase_day, or within cap and the LATEST
 *         is the purchase day) → normalized = local × rate;                       [fresh]
 *       - within-cap STALE rate (a carried-forward weekend/holiday rate) →
 *         normalize + flag fx_stale_rate_used;                                    [stale]
 *       - missing / over-cap rate → PARK unconverted: normalized = 0, flag
 *         fx_unconverted (the amount still increments cnt/loc/payer; revenue count
 *         and normalization degrade independently, money is never blocked).       [parked]
 *
 *  2. MASTER-KEY DECRYPT BOUNDARY (P13): the operator's `fx_table` CONFIG material is a
 *     reversible infra secret, envelope-encrypted in GAME.config via SecretCryptoService
 *     (master key OUTSIDE Postgres). {@link decryptFxTable} decrypts it ONLY in-worker
 *     (the reconciliation job calls it to materialize FX_RATE rows). The hot path NEVER
 *     touches the ciphertext or the master key — it reads only the plaintext FX_RATE.
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FxRateEntity } from '../database/entities/fx-rate.entity';
import { SecretCryptoService } from '../security/secret-crypto.service';

/** The disposition of an FX normalization attempt. */
export type FxDisposition = 'fresh' | 'stale' | 'parked';

/** The result of normalizing one local amount at an as-of date. */
export interface FxResult {
  /** Normalized (converted) amount; 0 when parked. */
  normalized: string;
  /** The as-of disposition (drives the fx_stale_rate_used / fx_unconverted tallies). */
  disposition: FxDisposition;
  /** The rate applied (string), or null when parked. */
  rate: string | null;
  /** The rate_date actually used (as-of), or null when parked. */
  rateDate: string | null;
}

/** Number of whole days between two "YYYY-MM-DD" dates (b − a). */
function dayDiff(a: string, b: string): number {
  const MS = 86_400_000;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / MS);
}

/** Multiply a decimal string × a decimal string, returning a fixed(6) string (bigint-safe magnitude). */
export function mulDecimal(localAmount: string, rate: string, scale = 6): string {
  // Parse to Number for magnitude arithmetic — amounts are money-scale (≪ 2^53), rates
  // are ratios; the 6-dp fixed output matches the numeric(…,6) columns. Non-finite → 0.
  const a = Number(localAmount);
  const r = Number(rate);
  if (!Number.isFinite(a) || !Number.isFinite(r)) {
    return '0';
  }
  return (a * r).toFixed(scale);
}

@Injectable()
export class FxService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly crypto: SecretCryptoService,
  ) {}

  /**
   * Normalize a local amount at `purchaseDay` under the as-of FX rule. `stalenessMaxDays`
   * is the game's `fx_staleness_max_days`. Reads the plaintext FX_RATE table only.
   */
  async normalize(
    gameId: string,
    currency: string,
    localAmount: string,
    purchaseDay: string,
    stalenessMaxDays: number,
  ): Promise<FxResult> {
    const asOf = await this.asOfRate(gameId, currency, purchaseDay);
    if (!asOf) {
      // Missing rate → park unconverted.
      return { normalized: '0', disposition: 'parked', rate: null, rateDate: null };
    }
    const age = dayDiff(asOf.rateDate, purchaseDay);
    if (age > stalenessMaxDays) {
      // Over-cap stale → park unconverted (a too-old rate is not trustworthy).
      return { normalized: '0', disposition: 'parked', rate: null, rateDate: null };
    }
    const normalized = mulDecimal(localAmount, asOf.rate);
    const disposition: FxDisposition = age === 0 ? 'fresh' : 'stale';
    return { normalized, disposition, rate: asOf.rate, rateDate: asOf.rateDate };
  }

  /**
   * The as-of rate: the most recent FX_RATE row with `rate_date ≤ purchaseDay` for
   * (game, currency), or null if none exists. Validity (staleness cap) is applied by
   * the caller so the "no in-cap rate" park case is distinguishable from "no row".
   */
  async asOfRate(
    gameId: string,
    currency: string,
    purchaseDay: string,
  ): Promise<{ rate: string; rateDate: string } | null> {
    const row = await this.dataSource
      .getRepository(FxRateEntity)
      .createQueryBuilder('fx')
      .where('fx.game_id = :gameId', { gameId })
      .andWhere('fx.currency = :currency', { currency })
      .andWhere('fx.rate_date <= :purchaseDay', { purchaseDay })
      .orderBy('fx.rate_date', 'DESC')
      .limit(1)
      .getOne();
    if (!row) {
      return null;
    }
    // TypeORM returns `date` columns as "YYYY-MM-DD" strings; guard defensively.
    const rateDate =
      typeof row.rateDate === 'string' ? row.rateDate : new Date(row.rateDate).toISOString().slice(0, 10);
    return { rate: row.rate, rateDate };
  }

  /**
   * Decrypt the operator's `fx_table` ciphertext (P13 master-key boundary). Called
   * ONLY by the reconciliation job in-worker to materialize FX_RATE rows. The parsed
   * shape is `{ [currency]: { [rate_date]: rate } }` (operator-supplied). A blank /
   * unconfigured master key or malformed material throws — the job surfaces it.
   */
  decryptFxTable(ciphertext: string): Record<string, Record<string, number>> {
    const plaintext = this.crypto.decrypt(ciphertext);
    const parsed: unknown = JSON.parse(plaintext);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('[fx] decrypted fx_table is not a currency→date→rate object');
    }
    const out: Record<string, Record<string, number>> = {};
    for (const [currency, dates] of Object.entries(parsed as Record<string, unknown>)) {
      if (!dates || typeof dates !== 'object' || Array.isArray(dates)) {
        continue;
      }
      const byDate: Record<string, number> = {};
      for (const [date, rate] of Object.entries(dates as Record<string, unknown>)) {
        if (typeof rate === 'number' && Number.isFinite(rate) && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
          byDate[date] = rate;
        }
      }
      if (Object.keys(byDate).length > 0) {
        out[currency] = byDate;
      }
    }
    return out;
  }
}
