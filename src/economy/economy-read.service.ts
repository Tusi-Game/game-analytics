/**
 * Economy read model ([004-economy] design API read model, T-03.30..40) —
 * READ-TIME only; nothing here is stored. Every figure is derived from the stored
 * amount_sum / event_count cells + the BALANCE_SNAPSHOT / ECONOMY_SUPPLY_DAY rows.
 *
 *   source / sink / day  = Σ amount_sum over base cells, collapsing provenance +
 *                          reason (sealed days from Postgres; the open day
 *                          live-merged from the `eco` bucket, GREATEST per cell).
 *   net_flow             = total_source − total_sink               (PRIMARY, always defined)
 *   sink_ratio           = total_sink / total_source; N/A when total_source = 0
 *                          (never 0/∞/NaN). Low-volume guard: when EITHER leg's
 *                          event_count < economy_ratio_min_events → annotated
 *                          "low volume — unreliable" (display-only).
 *   top faucets / drains = per-reason Σ sorted desc, take economy_top_n_reasons.
 *   money_supply / depth = Σ / percentiles over BALANCE_SNAPSHOT (dormant holders
 *                          counted; labelled "over N balance-reporting holders").
 *   supply trend         = ECONOMY_SUPPLY_DAY rows + optional cumulative-net-flow overlay.
 *
 * A provenance slice (`server` = trusted-only) and a segment slice reuse the same
 * computations over the filtered cells.
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { EconomyConfigService } from './economy-config.service';
import { EcoKeys, parseEcoField, MEASURE_AMOUNT, MEASURE_COUNT } from './eco-keys';

/** One reason's source/sink contribution. */
export interface ReasonTotal {
  reason: string;
  amount: number;
}

/** Per game × currency × day source/sink figures + the derived metrics. */
export interface EconomyDayView {
  gameId: string;
  currency: string;
  utcDay: string;
  totalSource: number;
  totalSink: number;
  /** total_source − total_sink (PRIMARY; always defined). */
  netFlow: number;
  /** total_sink / total_source, or null when total_source = 0 (N/A, never ∞/NaN). */
  sinkRatio: number | null;
  /** Symmetric bounded form (sink − source)/(sink + source) ∈ [−1,+1], or null. */
  sinkRatioBounded: number | null;
  /** True iff EITHER leg's event count < economy_ratio_min_events (display mask). */
  lowVolume: boolean;
  sourceEventCount: number;
  sinkEventCount: number;
  topFaucets: ReasonTotal[];
  topDrains: ReasonTotal[];
  /** True iff any open-day live value contributed (provisional). */
  provisional: boolean;
}

/** Money-supply / depth at a point in time (current, from BALANCE_SNAPSHOT). */
export interface MoneySupplyView {
  gameId: string;
  currency: string;
  /** Σ last_known_balance over every balance-reporting holder (dormant counted). */
  moneySupply: number;
  /** Balance-reporting holder count (the coverage denominator). */
  nUsers: number;
  p50: number;
  p90: number;
  /** UI label — supply is over balance-reporting holders, never an unqualified total. */
  coverageLabel: string;
}

/** One day of the money-supply trend (from ECONOMY_SUPPLY_DAY). */
export interface SupplyTrendPoint {
  utcDay: string;
  moneySupply: number;
  nUsers: number;
  depthPercentiles: Record<string, number>;
  trustedSupply: number;
  /** Cumulative Σ net_flow up to and including this day (overlay diagnostic). */
  cumulativeNetFlow: number;
  /** measured supply − cumulative-net-flow-implied supply (untracked/spoofed signal). */
  divergence: number;
}

/** An accumulated cell during a read scan. */
interface Acc {
  sourceAmount: number;
  sinkAmount: number;
  sourceCount: number;
  sinkCount: number;
  /** reason → source amount. */
  sourceByReason: Map<string, number>;
  /** reason → sink amount. */
  sinkByReason: Map<string, number>;
}

function emptyAcc(): Acc {
  return {
    sourceAmount: 0,
    sinkAmount: 0,
    sourceCount: 0,
    sinkCount: 0,
    sourceByReason: new Map(),
    sinkByReason: new Map(),
  };
}

@Injectable()
export class EconomyReadService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly dataSource: DataSource,
    private readonly economyConfig: EconomyConfigService,
  ) {}

  /**
   * Per game × currency × day economy view. `provenanceFilter` = 'server' yields
   * the trusted-only slice; omit for the provenance-collapsed headline.
   */
  async economyDay(
    gameId: string,
    currency: string,
    utcDay: string,
    opts: { provenanceFilter?: 'server' | 'client'; now?: number } = {},
  ): Promise<EconomyDayView> {
    const now = opts.now ?? Date.now();
    const acc = emptyAcc();

    // ---- durable base cells (Postgres) --------------------------------------
    const durable: Array<{
      provenance: string;
      reason: string;
      flow_type: string;
      amount_sum: string;
      event_count: string;
    }> = await this.dataSource.query(
      `SELECT provenance, reason, flow_type, amount_sum::text AS amount_sum, event_count::text AS event_count
         FROM economy_flow_result
        WHERE game_id = $1 AND currency = $2 AND utc_day = $3`,
      [gameId, currency, utcDay],
    );
    for (const r of durable) {
      if (opts.provenanceFilter && r.provenance !== opts.provenanceFilter) {
        continue;
      }
      this.foldCell(acc, r.flow_type, r.reason, Number(r.amount_sum), Number(r.event_count));
    }

    // ---- open-day live merge (Redis) — GREATEST per cell, like session-read --
    let provisional = false;
    const today = this.economyConfig.todayLogical(now);
    if (utcDay >= today) {
      const live = await this.redis.hgetall(EcoKeys.eco(gameId, utcDay));
      delete live['__seeded'];
      // Merge live over durable: a live cell that EXCEEDS its durable counterpart
      // replaces it (GREATEST), matching the class-M flush semantics. We rebuild the
      // acc from a per-cell max so live and durable never double-count.
      if (Object.keys(live).length > 0) {
        const merged = this.mergeLiveOverDurable(durable, live, currency, opts.provenanceFilter);
        if (merged.touched) {
          provisional = true;
          // Replace acc with the merged fold.
          Object.assign(acc, merged.acc);
        }
      }
    }

    const topN = await this.economyConfig.topNReasons(gameId);
    const minEvents = await this.economyConfig.ratioMinEvents(gameId);

    const totalSource = acc.sourceAmount;
    const totalSink = acc.sinkAmount;
    const netFlow = totalSource - totalSink;
    const sinkRatio = totalSource === 0 ? null : totalSink / totalSource;
    const denom = totalSource + totalSink;
    const sinkRatioBounded = denom === 0 ? null : (totalSink - totalSource) / denom;
    const lowVolume = acc.sourceCount < minEvents || acc.sinkCount < minEvents;

    return {
      gameId,
      currency,
      utcDay,
      totalSource,
      totalSink,
      netFlow,
      sinkRatio,
      sinkRatioBounded,
      lowVolume,
      sourceEventCount: acc.sourceCount,
      sinkEventCount: acc.sinkCount,
      topFaucets: topReasons(acc.sourceByReason, topN),
      topDrains: topReasons(acc.sinkByReason, topN),
      provisional,
    };
  }

  /** Fold one flow cell into the accumulator. */
  private foldCell(acc: Acc, flowType: string, reason: string, amount: number, count: number): void {
    if (flowType === 'source') {
      acc.sourceAmount += amount;
      acc.sourceCount += count;
      acc.sourceByReason.set(reason, (acc.sourceByReason.get(reason) ?? 0) + amount);
    } else if (flowType === 'sink') {
      acc.sinkAmount += amount;
      acc.sinkCount += count;
      acc.sinkByReason.set(reason, (acc.sinkByReason.get(reason) ?? 0) + amount);
    }
  }

  /**
   * Merge the live open-day hash OVER the durable cells with GREATEST per cell
   * (amount + count independently). Returns a fresh accumulator so the caller
   * never double-counts a cell present in both. The live hash carries tagged
   * fields (`a␟…` amount, `n␟…` count).
   */
  private mergeLiveOverDurable(
    durable: Array<{ provenance: string; reason: string; flow_type: string; amount_sum: string; event_count: string }>,
    live: Record<string, string>,
    currency: string,
    provenanceFilter?: 'server' | 'client',
  ): { acc: Acc; touched: boolean } {
    // Build a per-cell max map keyed by (provenance, flow, reason) for this currency.
    const amt = new Map<string, number>();
    const cnt = new Map<string, number>();
    const meta = new Map<string, { provenance: string; flow: string; reason: string }>();
    const key = (p: string, f: string, r: string): string => [p, f, r].join('\x1f');

    for (const d of durable) {
      const k = key(d.provenance, d.flow_type, d.reason);
      amt.set(k, Math.max(amt.get(k) ?? 0, Number(d.amount_sum)));
      cnt.set(k, Math.max(cnt.get(k) ?? 0, Number(d.event_count)));
      meta.set(k, { provenance: d.provenance, flow: d.flow_type, reason: d.reason });
    }
    let touched = false;
    for (const [field, value] of Object.entries(live)) {
      const cell = parseEcoField(field);
      if (!cell || cell.currency !== currency) {
        continue;
      }
      touched = true;
      const k = key(cell.provenance, cell.flowType, cell.reason);
      meta.set(k, { provenance: cell.provenance, flow: cell.flowType, reason: cell.reason });
      if (cell.measure === MEASURE_AMOUNT) {
        amt.set(k, Math.max(amt.get(k) ?? 0, Number(value)));
      } else if (cell.measure === MEASURE_COUNT) {
        cnt.set(k, Math.max(cnt.get(k) ?? 0, Number(value)));
      }
    }

    const acc = emptyAcc();
    for (const [k, m] of meta) {
      if (provenanceFilter && m.provenance !== provenanceFilter) {
        continue;
      }
      this.foldCell(acc, m.flow, m.reason, amt.get(k) ?? 0, cnt.get(k) ?? 0);
    }
    return { acc, touched };
  }

  /**
   * Current money supply + depth for a game × currency, directly over the durable
   * BALANCE_SNAPSHOT rows (point-in-time; `bal` is day-less so no open-day Redis
   * merge). money_supply = Σ last_known_balance over EVERY user who ever reported
   * a balance (dormant stockpilers counted). `provenanceFilter = 'server'` yields
   * the advisory trusted-only supply (last-writer-was-server slice).
   */
  async moneySupply(
    gameId: string,
    currency: string,
    opts: { provenanceFilter?: 'server' | 'client' } = {},
  ): Promise<MoneySupplyView> {
    const params: unknown[] = [gameId, currency];
    let where = 'game_id = $1 AND currency = $2';
    if (opts.provenanceFilter) {
      params.push(opts.provenanceFilter);
      where += ` AND provenance = $${params.length}`;
    }
    const rows: Array<{ last_known_balance: string }> = await this.dataSource.query(
      `SELECT last_known_balance::text AS last_known_balance
         FROM balance_snapshot
        WHERE ${where}`,
      params,
    );
    // Sort NUMERICALLY in JS: a SQL `ORDER BY last_known_balance` would sort the
    // ::text output alias LEXICALLY ("1300" < "2200" < "800"), corrupting percentiles.
    const balances = rows.map((r) => Number(r.last_known_balance)).sort((a, b) => a - b);
    const moneySupply = balances.reduce((s, v) => s + v, 0);
    return {
      gameId,
      currency,
      moneySupply,
      nUsers: balances.length,
      p50: pctl(balances, 0.5),
      p90: pctl(balances, 0.9),
      coverageLabel: `over ${balances.length} balance-reporting holders`,
    };
  }

  /**
   * Money-supply trend from ECONOMY_SUPPLY_DAY over [from, to], with a query-time
   * cumulative Σ net_flow overlay over ECONOMY_FLOW_RESULT — the divergence between
   * measured supply and cumulative-flow-implied supply is the untracked/spoofed
   * diagnostic (Q5). Cumulative net-flow is NOT stored.
   */
  async supplyTrend(gameId: string, currency: string, from: string, to: string): Promise<SupplyTrendPoint[]> {
    const supplyRows: Array<{
      utc_day: string;
      money_supply: string;
      n_users: number;
      depth_percentiles: Record<string, number>;
      trusted_supply: string;
    }> = await this.dataSource.query(
      `SELECT utc_day::text AS utc_day, money_supply::text AS money_supply, n_users,
              depth_percentiles, trusted_supply::text AS trusted_supply
         FROM economy_supply_day
        WHERE game_id = $1 AND currency = $2 AND utc_day BETWEEN $3 AND $4
        ORDER BY utc_day ASC`,
      [gameId, currency, from, to],
    );

    // Cumulative net_flow per day (window running-total), up to each supply day.
    const flowRows: Array<{ utc_day: string; net: string }> = await this.dataSource.query(
      `SELECT utc_day::text AS utc_day,
              SUM(CASE WHEN flow_type = 'source' THEN amount_sum ELSE -amount_sum END)::text AS net
         FROM economy_flow_result
        WHERE game_id = $1 AND currency = $2 AND utc_day <= $3
        GROUP BY utc_day
        ORDER BY utc_day ASC`,
      [gameId, currency, to],
    );
    const netByDay = new Map(flowRows.map((r) => [r.utc_day, Number(r.net)]));
    // Cumulative up to each day (inclusive).
    const cumulativeUpTo = (day: string): number => {
      let sum = 0;
      for (const [d, n] of netByDay) {
        if (d <= day) {
          sum += n;
        }
      }
      return sum;
    };

    return supplyRows.map((r) => {
      const cumulativeNetFlow = cumulativeUpTo(r.utc_day);
      const moneySupply = Number(r.money_supply);
      return {
        utcDay: r.utc_day,
        moneySupply,
        nUsers: r.n_users,
        depthPercentiles: r.depth_percentiles ?? {},
        trustedSupply: Number(r.trusted_supply),
        cumulativeNetFlow,
        divergence: moneySupply - cumulativeNetFlow,
      };
    });
  }

  /**
   * Segment slice: identical source/sink/net/ratio computation over the
   * ECONOMY_FLOW_SEGMENT_RESULT cells for one (segment_dim, segment_value).
   * Sealed-only (segments are not open-day-merged in v1 — the base view carries
   * the provisional headline; segments are a durable drill-down).
   */
  async segmentDay(
    gameId: string,
    currency: string,
    utcDay: string,
    segmentDim: string,
    segmentValue: string,
    opts: { provenanceFilter?: 'server' | 'client' } = {},
  ): Promise<EconomyDayView> {
    const acc = emptyAcc();
    const rows: Array<{
      provenance: string;
      reason: string;
      flow_type: string;
      amount_sum: string;
      event_count: string;
    }> = await this.dataSource.query(
      `SELECT provenance, reason, flow_type, amount_sum::text AS amount_sum, event_count::text AS event_count
         FROM economy_flow_segment_result
        WHERE game_id = $1 AND currency = $2 AND utc_day = $3 AND segment_dim = $4 AND segment_value = $5`,
      [gameId, currency, utcDay, segmentDim, segmentValue],
    );
    for (const r of rows) {
      if (opts.provenanceFilter && r.provenance !== opts.provenanceFilter) {
        continue;
      }
      this.foldCell(acc, r.flow_type, r.reason, Number(r.amount_sum), Number(r.event_count));
    }

    const topN = await this.economyConfig.topNReasons(gameId);
    const minEvents = await this.economyConfig.ratioMinEvents(gameId);
    const totalSource = acc.sourceAmount;
    const totalSink = acc.sinkAmount;
    const denom = totalSource + totalSink;
    return {
      gameId,
      currency,
      utcDay,
      totalSource,
      totalSink,
      netFlow: totalSource - totalSink,
      sinkRatio: totalSource === 0 ? null : totalSink / totalSource,
      sinkRatioBounded: denom === 0 ? null : (totalSink - totalSource) / denom,
      lowVolume: acc.sourceCount < minEvents || acc.sinkCount < minEvents,
      sourceEventCount: acc.sourceCount,
      sinkEventCount: acc.sinkCount,
      topFaucets: topReasons(acc.sourceByReason, topN),
      topDrains: topReasons(acc.sinkByReason, topN),
      provisional: false,
    };
  }

  /** The observed currencies for a game (dashboard picker) — from `eco:cur`. */
  async currencies(gameId: string): Promise<string[]> {
    const members = await this.redis.smembers(EcoKeys.ecoCur(gameId));
    return members.sort();
  }
}

/** Top-N reasons by amount, descending (ties broken by reason for determinism). */
function topReasons(byReason: Map<string, number>, topN: number): ReasonTotal[] {
  return [...byReason.entries()]
    .map(([reason, amount]) => ({ reason, amount }))
    .sort((a, b) => (b.amount !== a.amount ? b.amount - a.amount : a.reason < b.reason ? -1 : 1))
    .slice(0, Math.max(0, topN));
}

/** Nearest-rank percentile over an ascending array (0 if empty). */
function pctl(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) {
    return 0;
  }
  if (sortedAsc.length === 1) {
    return sortedAsc[0]!;
  }
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx]!;
}
