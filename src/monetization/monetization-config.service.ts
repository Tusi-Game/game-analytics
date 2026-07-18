/**
 * Centralized monetization + derived-KPI §6/§7 config reader ([006-monetization] §6,
 * [007-derived-kpis] §7). All knobs are read forward-only via {@link GameConfigService};
 * the platform `reporting_offset` (Foundation §4.7, set-once) comes from env, resolved
 * identically to Session/Economy config so monetization days never disagree.
 *
 * The defaults here are APPENDED to GAME_CONFIG_DEFAULTS (game-config.service.ts) — a
 * change there is the single source; these constants mirror them for the read fallback.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GameConfigService } from '../config/game-config.service';
import { logicalDay } from '../common/kernel/logical-day';
import { ALL_DIMENSIONS, CLIENT_DIMENSIONS, DEFAULT_LEVEL_BUCKET_BOUNDARIES } from './dim-combo';

/** DI token to override the platform reporting offset (minutes) in tests. */
export const MONETIZATION_REPORTING_OFFSET_MINUTES = 'MONETIZATION_REPORTING_OFFSET_MINUTES';

/**
 * A payer-tier rule: fixed dollar thresholds evaluated against
 * `lifetime_spend_normalized` (bridge 05.5 §6, deltaDNA anchor). `minnow < dolphin_min
 * ≤ dolphin < whale_min ≤ whale`. Non-payer = no PAYER_SPINE_EXT row.
 */
export interface PayerTierRule {
  /** lifetime < dolphin_min → `minnow` (default 10). */
  dolphin_min: number;
  /** lifetime ≥ whale_min → `whale` (default 100). */
  whale_min: number;
}

/** Monetization §6 / derived-KPI §7 defaults (forward-only reads fall back to these). */
export const MONETIZATION_CONFIG_DEFAULTS = {
  /** Active report dimensions (rebuild-forward, FR-020). */
  monetization_dimensions: ['level_bucket', 'region', 'in_game_state', 'payer_tier'] as readonly string[],
  /** Per-dimension distinct-value cap (rebuild-forward); over-cap → `other`. */
  monetization_dimension_value_cap: 50,
  /** Payer-tier fixed dollar thresholds (future-reads; the spine stores spend not tier). */
  payer_tier_rule: { dolphin_min: 10, whale_min: 100 } as PayerTierRule,
  /** Max FX-rate staleness (days) before parking unconverted (future-reads). */
  fx_staleness_max_days: 7,
  /** Whale-cohort min-payers threshold (retroactive read-time). */
  whale_min_payers: 20,
  /** Whale top-percent cohorts (retroactive read-time). */
  whale_top_percents: [1, 5, 10] as readonly number[],
  /** MAU rolling window (days) (retroactive read-time). WAU 7 / DAU 1 are fixed. */
  mau_window_days: 30,
  /** Mask WAU/MAU/stickiness until the trailing window has fully elapsed. */
  partial_window_mask: true,
  /** First-purchase conversion denominator base. */
  arppu_first_purchase_denominator: 'active_users',
} as const;

/** Fixed derived-KPI windows. */
export const WAU_WINDOW_DAYS = 7;

@Injectable()
export class MonetizationConfigService {
  private readonly offsetOverride: number | undefined;

  constructor(
    private readonly gameConfig: GameConfigService,
    @Optional() config?: ConfigService,
    @Optional() @Inject(MONETIZATION_REPORTING_OFFSET_MINUTES) offsetOverride?: number,
  ) {
    void config;
    this.offsetOverride =
      typeof offsetOverride === 'number' && Number.isInteger(offsetOverride) ? offsetOverride : undefined;
  }

  /** Platform reporting offset (minutes), UTC (0) on anything unparseable. */
  reportingOffsetMinutes(): number {
    if (this.offsetOverride !== undefined) {
      return this.offsetOverride;
    }
    const raw = process.env.REPORTING_OFFSET;
    const n = raw === undefined ? Number.NaN : Number(raw);
    return Number.isInteger(n) ? n : 0;
  }

  /** Logical day "YYYY-MM-DD" of an instant, applying reporting_offset ONCE. */
  logicalDayOf(epochMs: number): string {
    return logicalDay(epochMs, this.reportingOffsetMinutes());
  }

  /** Platform logical TODAY (the provisional/open-day mask). */
  todayLogical(now: number = Date.now()): string {
    return logicalDay(now, this.reportingOffsetMinutes());
  }

  /**
   * The active `monetization_dimensions` for a game (sanitised to the known set), or
   * the default. NEVER the config declaration order for keying — the encoder sorts by
   * name (dim-combo.ts). Returns the raw (possibly reordered) list for iteration.
   */
  async monetizationDimensions(gameId: string): Promise<readonly string[]> {
    const cfg = await this.gameConfig.getConfig(gameId);
    const raw = cfg['monetization_dimensions'];
    if (Array.isArray(raw)) {
      const known: ReadonlySet<string> = new Set(ALL_DIMENSIONS);
      const parsed = raw.filter((v): v is string => typeof v === 'string' && known.has(v));
      if (parsed.length > 0) {
        return parsed;
      }
    }
    return MONETIZATION_CONFIG_DEFAULTS.monetization_dimensions;
  }

  /** The active client-only dims from the game's dimension set (need the cardinality guard). */
  async clientDimensions(gameId: string): Promise<string[]> {
    const dims = await this.monetizationDimensions(gameId);
    return dims.filter((d) => CLIENT_DIMENSIONS.has(d));
  }

  /** `monetization_dimension_value_cap` (per-dimension distinct-value budget). */
  async dimensionValueCap(gameId: string): Promise<number> {
    return (
      (await this.gameConfig.getNumber(gameId, 'monetization_dimension_value_cap')) ??
      MONETIZATION_CONFIG_DEFAULTS.monetization_dimension_value_cap
    );
  }

  /** `fx_staleness_max_days` — an as-of rate older than this parks unconverted. */
  async fxStalenessMaxDays(gameId: string): Promise<number> {
    return (
      (await this.gameConfig.getNumber(gameId, 'fx_staleness_max_days')) ??
      MONETIZATION_CONFIG_DEFAULTS.fx_staleness_max_days
    );
  }

  /** `payer_tier_rule` fixed thresholds (bridge 05.5 §6). */
  async payerTierRule(gameId: string): Promise<PayerTierRule> {
    const cfg = await this.gameConfig.getConfig(gameId);
    const raw = cfg['payer_tier_rule'];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      const dolphinMin = typeof obj['dolphin_min'] === 'number' ? obj['dolphin_min'] : undefined;
      const whaleMin = typeof obj['whale_min'] === 'number' ? obj['whale_min'] : undefined;
      if (dolphinMin !== undefined || whaleMin !== undefined) {
        return {
          dolphin_min: dolphinMin ?? MONETIZATION_CONFIG_DEFAULTS.payer_tier_rule.dolphin_min,
          whale_min: whaleMin ?? MONETIZATION_CONFIG_DEFAULTS.payer_tier_rule.whale_min,
        };
      }
    }
    return { ...MONETIZATION_CONFIG_DEFAULTS.payer_tier_rule };
  }

  /** `whale_min_payers` (below → low_confidence). */
  async whaleMinPayers(gameId: string): Promise<number> {
    return (
      (await this.gameConfig.getNumber(gameId, 'whale_min_payers')) ?? MONETIZATION_CONFIG_DEFAULTS.whale_min_payers
    );
  }

  /** `whale_top_percents` cohorts. */
  async whaleTopPercents(gameId: string): Promise<readonly number[]> {
    const cfg = await this.gameConfig.getConfig(gameId);
    const raw = cfg['whale_top_percents'];
    if (Array.isArray(raw)) {
      const parsed = raw.filter((v): v is number => typeof v === 'number' && v > 0 && v <= 50);
      if (parsed.length > 0) {
        return parsed;
      }
    }
    return MONETIZATION_CONFIG_DEFAULTS.whale_top_percents;
  }

  /** `mau_window_days` (rolling window). */
  async mauWindowDays(gameId: string): Promise<number> {
    return (await this.gameConfig.getNumber(gameId, 'mau_window_days')) ?? MONETIZATION_CONFIG_DEFAULTS.mau_window_days;
  }

  /** `partial_window_mask` — masks WAU/MAU/stickiness until the window elapsed. */
  async partialWindowMask(gameId: string): Promise<boolean> {
    return this.gameConfig.getBoolean(gameId, 'partial_window_mask');
  }

  /** `arppu_first_purchase_denominator` (`active_users` | `new_users`). */
  async firstPurchaseDenominator(gameId: string): Promise<'active_users' | 'new_users'> {
    const raw = await this.gameConfig.getString(gameId, 'arppu_first_purchase_denominator');
    return raw === 'new_users' ? 'new_users' : 'active_users';
  }

  /**
   * The game's `level_bucket_boundaries` (ascending), or the platform default. Used to
   * bucket the companion's raw `player_level` server-side at join time (the config lives
   * server-side, forward-only). Shared with 004-economy's boundary semantics.
   */
  async levelBucketBoundaries(gameId: string): Promise<number[]> {
    const cfg = await this.gameConfig.getConfig(gameId);
    const raw = cfg['level_bucket_boundaries'];
    if (Array.isArray(raw)) {
      const parsed = raw.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0);
      if (parsed.length > 0) {
        return [...parsed].sort((a, b) => a - b);
      }
    }
    return [...DEFAULT_LEVEL_BUCKET_BOUNDARIES];
  }
}

/** The UTC calendar-month `period` (YYYY-MM) of a logical day "YYYY-MM-DD". */
export function periodOfDay(logicalDayStr: string): string {
  return logicalDayStr.slice(0, 7);
}
