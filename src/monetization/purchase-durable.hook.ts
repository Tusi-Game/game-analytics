/**
 * Step-7 durable-immediate hook for `kind = purchase` ([006-monetization] design step
 * 6/7, bridge 05.5). Registered with the kind dispatcher under KIND_DURABLE_REGISTRATION.
 *
 * Runs ONLY for routed, deduped (kernel step-6 saw no existing row), open-day `purchase`
 * records. It is the AUTHORITATIVE 6a + 6b + 06-writes site, all inside ONE Postgres
 * transaction (the 05→06 atomic unit — gate row + PAYER_SPINE_EXT + PAYER_PERIOD_SPEND
 * commit together or not at all; bridge 05.5 §1):
 *
 *   COMPANION (source=client) → NOOP durable (no money, no gate). Token carries a
 *     companion marker so step 8 runs the companion-join path.
 *   SERVER (source=server):
 *     6a eligibility: verified=true ∧ environment=prod ∧ provenance=server. Ineligible
 *       → stop (no gate, no writes; the row was raw-appended at step 4, audit-only).
 *     payer_tier PRE-READ: read PAYER_SPINE_EXT existence + lifetime_spend_normalized
 *       (+ has_unconverted_spend) BEFORE any write — inverting this misclassifies every
 *       first purchase as `repeat` (bridge 05.5 §3).
 *     FX normalize (as-of, 3-way) → normalized_amount (may be 0/parked).
 *     6b gate: claimFull INSERT … ON CONFLICT DO NOTHING. Conflict → no-op the whole
 *       unit (exactly-once; a duplicate at any lateness produces zero effect).
 *     06 writes (same tx): PAYER_SPINE_EXT.first_purchase_day write-once +
 *       lifetime_spend_normalized += normalized (+ has_unconverted_spend on parked);
 *       PAYER_PERIOD_SPEND[period] += normalized.
 *
 * SPINE-INDEPENDENT (Q1, P9): 006 does NOT write USER_SPINE; the payer family keys
 * (game_id, user_id) as a logical association with NO enforced FK — a never-sessioned
 * payer commits normally. 006 only READS USER_SPINE.first_seen (step 8, days_since_install).
 *
 * The hook computes the purchase's resolved state once and hands ALL of it to step 8 via
 * the branded {@link DurableWrittenToken} (the kernel threads the SAME token in), so the
 * hot hook never recomputes FX / tier and the two steps cannot disagree.
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { RoutedRecord } from '../common/contracts/queue-jobs';
import type { DurableImmediateHook, DurableWrittenToken, SealCheckedToken } from '../workers/kernel/pipeline-steps';
import { PayerSpineExtEntity } from '../database/entities/payer-spine-ext.entity';
import { PurchaseDedupGateService, type PurchaseClaim } from './purchase-dedup-gate.service';
import { FxService, type FxDisposition } from './fx.service';
import { MonetizationConfigService, periodOfDay, type PayerTierRule } from './monetization-config.service';
import { readSource, readRequiredString, readNumber, readEnvironment, readRefunded } from './purchase-validator';

/** Payer tier read pre-purchase (bridge 05.5 §6). */
export type PayerTier = 'first' | 'repeat' | 'minnow' | 'dolphin' | 'whale' | 'indeterminate';

/**
 * The state the durable hook attaches to the branded step-7 token, read back by the
 * step-8 hot hook (both threaded the SAME token by the kernel).
 */
export interface PurchaseDurableState {
  /** Sub-contract: 'server' revenue row, 'client' companion, or 'ineligible' (6a stop). */
  readonly kind: 'server' | 'client' | 'ineligible' | 'invalid';
  /** For a server row that PASSED the gate: the full accept-signal state. */
  readonly accepted?: {
    readonly transactionId: string;
    readonly userId: string;
    readonly productId: string;
    readonly productCategory: string;
    readonly currency: string;
    readonly priceLocal: string;
    readonly purchaseDay: string;
    readonly normalized: string;
    readonly fxDisposition: FxDisposition;
    /** payer_tier stamped from PRE-purchase state (never retro-applied). */
    readonly payerTier: PayerTier;
  };
  /** For a companion: the join key (purchase_attempt_id). */
  readonly purchaseAttemptId?: string;
}

const PURCHASE_STATE = '__purchase_durable_state';
type PurchaseDurableToken = DurableWrittenToken & { readonly [PURCHASE_STATE]: PurchaseDurableState };

function brandToken(state: PurchaseDurableState): PurchaseDurableToken {
  return { [PURCHASE_STATE]: state } as unknown as PurchaseDurableToken;
}

/** Read the purchase state off a step-7 token, or null if not purchase-authored. */
export function readPurchaseDurableState(token: DurableWrittenToken): PurchaseDurableState | null {
  const candidate = token as Partial<PurchaseDurableToken>;
  return candidate[PURCHASE_STATE] ?? null;
}

/** Classify a payer tier from lifetime spend + first-purchase + parked state (bridge 05.5 §6). */
export function classifyTier(
  hadRowBefore: boolean,
  lifetimeBefore: number,
  hadUnconverted: boolean,
  rule: PayerTierRule,
): PayerTier {
  if (!hadRowBefore) {
    return 'first';
  }
  if (hadUnconverted) {
    // True lifetime is a lower bound → abstain, never a deflated minnow.
    return 'indeterminate';
  }
  if (lifetimeBefore >= rule.whale_min) {
    return 'whale';
  }
  if (lifetimeBefore >= rule.dolphin_min) {
    return 'dolphin';
  }
  return 'minnow';
}

@Injectable()
export class PurchaseDurableHook implements DurableImmediateHook {
  constructor(
    private readonly dataSource: DataSource,
    private readonly gate: PurchaseDedupGateService,
    private readonly fx: FxService,
    private readonly config: MonetizationConfigService,
  ) {}

  async write(record: RoutedRecord, _sealChecked: SealCheckedToken): Promise<DurableWrittenToken> {
    const { envelope } = record;
    const gameId = envelope.game_id;
    const props = envelope.props;

    const source = readSource(props);
    if (source === null) {
      // Should have quarantined at step 3; defensive no-op.
      return brandToken({ kind: 'invalid' });
    }

    // ---- Companion: no durable money work. Hand the join key to step 8. --------
    if (source === 'client') {
      const purchaseAttemptId = readRequiredString(props, 'purchase_attempt_id') ?? '';
      return brandToken({ kind: 'client', purchaseAttemptId });
    }

    // ---- Server row: 6a eligibility (verified ∧ prod ∧ provenance=server) ------
    const verified = props['verified'] === true;
    const environment = readEnvironment(props);
    if (!verified || environment !== 'prod' || record.provenance !== 'server') {
      // Ineligible: zero revenue, NO idempotency insert, NO 06 writes (audit-only).
      return brandToken({ kind: 'ineligible' });
    }

    const transactionId = readRequiredString(props, 'transaction_id') ?? '';
    const userId = readRequiredString(props, 'user_id') ?? envelope.user_id ?? '';
    const productId = readRequiredString(props, 'product_id') ?? '';
    const productCategory = readRequiredString(props, 'product_category') ?? '';
    const currency = readRequiredString(props, 'currency') ?? '';
    const priceLocalNum = readNumber(props, 'price_local') ?? 0;
    const purchaseDay = record.corrected_day; // P8: verbatim logical day.
    const period = periodOfDay(purchaseDay);
    const priceLocal = String(priceLocalNum);

    // ---- FX normalize (as-of, 3-way). Read before the tx (pure read). ---------
    const stalenessMax = await this.config.fxStalenessMaxDays(gameId);
    const fxResult = await this.fx.normalize(gameId, currency, priceLocal, purchaseDay, stalenessMax);
    const parked = fxResult.disposition === 'parked';
    const tierRule = await this.config.payerTierRule(gameId);

    // ---- The 05→06 ATOMIC UNIT: payer_tier PRE-READ → gate → 06 writes --------
    let payerTier: PayerTier = 'first';
    let claimed = false;
    await this.dataSource.transaction(async (manager) => {
      // payer_tier PRE-READ — BEFORE any write (invert → first misclassifies as repeat).
      const before = await manager.getRepository(PayerSpineExtEntity).findOne({
        where: { gameId, userId },
        select: { lifetimeSpendNormalized: true, hasUnconvertedSpend: true },
      });
      const hadRowBefore = before !== null;
      const lifetimeBefore = before ? Number(before.lifetimeSpendNormalized) : 0;
      const hadUnconverted = before?.hasUnconvertedSpend ?? false;
      payerTier = classifyTier(hadRowBefore, lifetimeBefore, hadUnconverted, tierRule);

      // 6b gate: authoritative durable claim (INSERT … ON CONFLICT DO NOTHING).
      const claim: PurchaseClaim = {
        transactionId,
        originalTransactionId: readRequiredString(props, 'original_transaction_id') ?? transactionId,
        gameId,
        userId,
        purchaseDay,
        priceLocal,
        currency,
        productId,
        refunded: readRefunded(props),
      };
      const outcome = await this.gate.claimFull(manager, claim);
      if (outcome === 'duplicate') {
        // True duplicate at any lateness → no-op the whole unit (exactly-once).
        return;
      }
      claimed = true;

      // 06 writes (same tx). first_purchase_day write-once; lifetime/period += normalized.
      await this.writeFirstPurchaseWriteOnce(manager, gameId, userId, purchaseDay, fxResult.normalized, parked);
      await this.incrementPeriodSpend(manager, gameId, period, userId, fxResult.normalized);
    });

    if (!claimed) {
      // Duplicate — step 8 must not re-count. Signal a duplicate server row.
      return brandToken({ kind: 'ineligible' });
    }

    return brandToken({
      kind: 'server',
      accepted: {
        transactionId,
        userId,
        productId,
        productCategory,
        currency,
        priceLocal,
        purchaseDay,
        normalized: fxResult.normalized,
        fxDisposition: fxResult.disposition,
        payerTier,
      },
    });
  }

  /**
   * PAYER_SPINE_EXT: insert-if-absent with first_purchase_day = purchaseDay (write-once,
   * never backdated); on conflict, lifetime_spend_normalized += normalized and OR the
   * has_unconverted_spend flag (parked amount contributes 0 to lifetime but sets the
   * flag so the tier reads `indeterminate`). All in the caller's tx.
   */
  private async writeFirstPurchaseWriteOnce(
    manager: import('typeorm').EntityManager,
    gameId: string,
    userId: string,
    purchaseDay: string,
    normalized: string,
    parked: boolean,
  ): Promise<void> {
    // INSERT (first_purchase_day, lifetime += normalized, has_unconverted = parked) ON
    // CONFLICT DO UPDATE: keep first_purchase_day (write-once), add to lifetime, OR flag.
    await manager.query(
      `INSERT INTO payer_spine_ext
         (game_id, user_id, first_purchase_day, lifetime_spend_normalized, has_unconverted_spend)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (game_id, user_id) DO UPDATE SET
         lifetime_spend_normalized = payer_spine_ext.lifetime_spend_normalized + EXCLUDED.lifetime_spend_normalized,
         has_unconverted_spend = payer_spine_ext.has_unconverted_spend OR EXCLUDED.has_unconverted_spend;`,
      [gameId, userId, purchaseDay, normalized, parked],
    );
  }

  /** PAYER_PERIOD_SPEND[game, period, user] += normalized (cumulative, same tx). */
  private async incrementPeriodSpend(
    manager: import('typeorm').EntityManager,
    gameId: string,
    period: string,
    userId: string,
    normalized: string,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO payer_period_spend (game_id, period, user_id, spend_normalized)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (game_id, period, user_id) DO UPDATE SET
         spend_normalized = payer_period_spend.spend_normalized + EXCLUDED.spend_normalized;`,
      [gameId, period, userId, normalized],
    );
  }
}
