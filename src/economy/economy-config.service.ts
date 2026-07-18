/**
 * Centralized economy §7 config reader (T-03.41/42) + the shared logical-day
 * source (P8). All knobs are read forward-only via {@link GameConfigService}; the
 * platform `reporting_offset` (Foundation §4.7, set-once) comes from env
 * (REPORTING_OFFSET minutes) — resolved identically to SessionConfigService so
 * economy days and session days never disagree.
 *
 * ============================ depth_capture_mode reconciliation ============
 * The committed config-contract (config-contract.ts) declares
 * `economy_depth_capture_mode` with enum ['off','shallow','full']; spec §7 lists
 * ['last_known_balance','off']. Per the settled decision we DO NOT change the
 * committed contract — we RECONCILE at read time:
 *   - 'off'                → depth OFF (no BALANCE_SNAPSHOT / bal map / supply row).
 *   - 'full' | 'shallow'   → depth ON  (≈ spec's `last_known_balance`).
 *   - 'last_known_balance' → depth ON  (accept the spec token too, for forward
 *                            compatibility if a future contract restores it).
 *   - unset                → depth ON  (the ratified story-level default is
 *                            `last_known_balance` = capture; spec §7 note).
 * {@link depthCaptureOn} is the single predicate every write site consults.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GameConfigService } from '../config/game-config.service';
import { logicalDay } from '../common/kernel/logical-day';

/** DI token to override the platform reporting offset (minutes) in tests. */
export const ECONOMY_REPORTING_OFFSET_MINUTES = 'ECONOMY_REPORTING_OFFSET_MINUTES';

/** Economy §7 defaults (forward-only reads fall back to these). */
export const ECONOMY_CONFIG_DEFAULTS = {
  economy_top_n_reasons: 10,
  economy_ratio_min_events: 100,
  economy_currency_cap_per_game: 500,
  /** Depth ON by default (ratified `last_known_balance`; stored as contract 'full'). */
  economy_depth_capture_mode: 'full',
} as const;

/** Currency-cap modes that mean depth is ON. */
const DEPTH_ON_MODES: ReadonlySet<string> = new Set(['full', 'shallow', 'last_known_balance']);

@Injectable()
export class EconomyConfigService {
  private readonly offsetOverride: number | undefined;

  constructor(
    private readonly gameConfig: GameConfigService,
    @Optional() config?: ConfigService,
    @Optional() @Inject(ECONOMY_REPORTING_OFFSET_MINUTES) offsetOverride?: number,
  ) {
    // Resolve the offset lazily from process.env (never the cached ConfigService)
    // for the exact reason SessionConfigService documents (cache-poisoning of a
    // string "0"). The DI override wins in tests.
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

  /** Platform logical TODAY (used by the provisional/open-day mask). */
  todayLogical(now: number = Date.now()): string {
    return logicalDay(now, this.reportingOffsetMinutes());
  }

  /** Is depth capture ON for this game? (the single write-gate predicate). */
  async depthCaptureOn(gameId: string): Promise<boolean> {
    const mode =
      (await this.gameConfig.getString(gameId, 'economy_depth_capture_mode')) ??
      ECONOMY_CONFIG_DEFAULTS.economy_depth_capture_mode;
    return DEPTH_ON_MODES.has(mode);
  }

  /** `economy_top_n_reasons` (retroactive display re-rank). */
  async topNReasons(gameId: string): Promise<number> {
    return (
      (await this.gameConfig.getNumber(gameId, 'economy_top_n_reasons')) ??
      ECONOMY_CONFIG_DEFAULTS.economy_top_n_reasons
    );
  }

  /** `economy_ratio_min_events` (display-only low-volume mask threshold). */
  async ratioMinEvents(gameId: string): Promise<number> {
    return (
      (await this.gameConfig.getNumber(gameId, 'economy_ratio_min_events')) ??
      ECONOMY_CONFIG_DEFAULTS.economy_ratio_min_events
    );
  }

  /**
   * The `economy_currency_allowlist` for a game, or null when empty (= accept-all,
   * the default). A non-empty list makes the step-3 validator quarantine any
   * currency outside it (forward-only).
   */
  async currencyAllowlist(gameId: string): Promise<ReadonlySet<string> | null> {
    const config = await this.gameConfig.getConfig(gameId);
    const raw = config['economy_currency_allowlist'];
    if (!Array.isArray(raw) || raw.length === 0) {
      return null;
    }
    const list = raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return list.length > 0 ? new Set(list) : null;
  }

  /**
   * The game's `level_bucket_boundaries` (ascending thresholds), or the platform
   * default. Used to compute `level_bucket` at ingest (forward-only).
   */
  async levelBucketBoundaries(gameId: string): Promise<number[]> {
    const config = await this.gameConfig.getConfig(gameId);
    const raw = config['level_bucket_boundaries'];
    if (Array.isArray(raw)) {
      const parsed = raw.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0);
      if (parsed.length > 0) {
        return [...parsed].sort((a, b) => a - b);
      }
    }
    return [...DEFAULT_LEVEL_BUCKET_BOUNDARIES];
  }
}

/** Platform-default level-bucket boundaries (ascending level thresholds). */
export const DEFAULT_LEVEL_BUCKET_BOUNDARIES: readonly number[] = [10, 20, 30, 40, 50];

/**
 * Compute the `level_bucket` label for a raw `player_level` given ascending
 * boundaries `b`. The raw level is NEVER stored — only this label. Buckets:
 *   level < b[0]              → `<b[0]`
 *   b[i] ≤ level < b[i+1]     → `b[i]-{b[i+1]-1}`
 *   level ≥ last boundary     → `{last}+`
 * Returns null when `player_level` is absent/non-numeric (skip the axis).
 */
export function computeLevelBucket(playerLevel: unknown, boundaries: readonly number[]): string | null {
  if (typeof playerLevel !== 'number' || !Number.isFinite(playerLevel)) {
    return null;
  }
  const level = Math.floor(playerLevel);
  if (boundaries.length === 0) {
    return `${level}`;
  }
  if (level < boundaries[0]!) {
    return `<${boundaries[0]}`;
  }
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    if (level >= boundaries[i]! && level < boundaries[i + 1]!) {
      return `${boundaries[i]}-${boundaries[i + 1]! - 1}`;
    }
  }
  return `${boundaries[boundaries.length - 1]}+`;
}
