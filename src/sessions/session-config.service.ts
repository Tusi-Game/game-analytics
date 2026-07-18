/**
 * Centralized session/retention config + logical-day source (T-02.6, T-04.6, and
 * tasks §4 flag #5 — "centralize the logical-today source so mask, seal, and floor
 * never disagree").
 *
 * All §6 knobs are read forward-only via {@link GameConfigService}; the platform
 * `reporting_offset` (Foundation §4.7, set-once) comes from env (REPORTING_OFFSET
 * minutes). `today_logical`, cohort day, and offset math ALL route through this
 * one service so nothing computes a day in raw UTC (P8).
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GameConfigService, GAME_CONFIG_DEFAULTS } from '../config/game-config.service';
import { logicalDay } from '../common/kernel/logical-day';
import { SESSION_TIME_DEFAULTS, type SessionTimeKnobs } from './session-time';

/** DI token to override the platform reporting offset (minutes) in tests. */
export const REPORTING_OFFSET_MINUTES = 'SESSION_REPORTING_OFFSET_MINUTES';

/** Default retention day targets ([005-retention] §6). */
export const DEFAULT_RETENTION_DAY_TARGETS: readonly number[] = [1, 7, 30];
/** Headroom added to max(retention_day_targets) to size the bitmap span. */
export const BITMAP_SPAN_HEADROOM = 15;
/** Default min cohort size for the small-cohort read mask ([005-retention] §6). */
export const DEFAULT_RETENTION_MIN_COHORT_SIZE = 30;

@Injectable()
export class SessionConfigService {
  /** Explicit DI/test override (minutes); undefined ⇒ read from env on demand. */
  private readonly offsetOverride: number | undefined;

  constructor(
    private readonly gameConfig: GameConfigService,
    @Optional() config?: ConfigService,
    @Optional() @Inject(REPORTING_OFFSET_MINUTES) offsetOverride?: number,
  ) {
    // Do NOT eagerly read REPORTING_OFFSET via ConfigService here: `@nestjs/config`
    // with `cache: true` caches whatever source wins on the FIRST get() of a key,
    // and a module-init read could cache the raw `process.env` STRING ("0"),
    // poisoning the worker's later numeric read (which then fails `logicalDay`'s
    // integer guard). We resolve lazily from `process.env` directly (coerced) so we
    // never touch — nor poison — the shared ConfigService cache.
    void config;
    this.offsetOverride =
      typeof offsetOverride === 'number' && Number.isInteger(offsetOverride) ? offsetOverride : undefined;
  }

  /**
   * Platform reporting offset in minutes (Foundation §4.7). Resolved from the DI
   * override if present, else parsed straight from `process.env.REPORTING_OFFSET`
   * (env vars are strings) — coerced to a safe integer minute count, UTC (0) on
   * anything unparseable. Never reads the cached ConfigService value.
   */
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

  /** Platform logical TODAY (used by immature/provisional masks). */
  todayLogical(now: number = Date.now()): string {
    return logicalDay(now, this.reportingOffsetMinutes());
  }

  /** The two §6 trusted-duration knobs for a game (forward-only reads). */
  async timeKnobs(gameId: string): Promise<SessionTimeKnobs> {
    const maxDurationCapMin =
      (await this.gameConfig.getNumber(gameId, 'session_max_duration_cap_min')) ??
      SESSION_TIME_DEFAULTS.maxDurationCapMin;
    const minDurationMs =
      (await this.gameConfig.getNumber(gameId, 'session_min_duration_ms')) ?? SESSION_TIME_DEFAULTS.minDurationMs;
    return { maxDurationCapMin, minDurationMs };
  }

  /** `session_inactivity_timeout_min` (SDK-side boundary; read for surfacing only). */
  async inactivityTimeoutMin(gameId: string): Promise<number> {
    return (
      (await this.gameConfig.getNumber(gameId, 'session_inactivity_timeout_min')) ??
      GAME_CONFIG_DEFAULTS.session_inactivity_timeout_min
    );
  }

  /** Retention day targets for a game (forward-only widening). */
  async retentionDayTargets(gameId: string): Promise<number[]> {
    const config = await this.gameConfig.getConfig(gameId);
    const raw = config['retention_day_targets'];
    if (Array.isArray(raw)) {
      const parsed = raw.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0);
      if (parsed.length > 0) {
        return parsed;
      }
    }
    return [...DEFAULT_RETENTION_DAY_TARGETS];
  }

  /** `retention_min_cohort_size` — the display-only small-cohort mask threshold. */
  async minCohortSize(gameId: string): Promise<number> {
    return (await this.gameConfig.getNumber(gameId, 'retention_min_cohort_size')) ?? DEFAULT_RETENTION_MIN_COHORT_SIZE;
  }

  /**
   * Bitmap span = max(retention_day_targets) + headroom (default 30 + 15 = 45).
   * Bits are addressed 0 .. span−1, so offset == max(targets) (e.g. 30) is well
   * within range; over-horizon offsets (offset ≥ span) are a silent no-op. Fixed
   * per game at seed time; widening is forward-only (new rows get the wider span,
   * old rows keep theirs — an offset beyond an old row's span is over-horizon).
   */
  async bitmapSpan(gameId: string): Promise<number> {
    const targets = await this.retentionDayTargets(gameId);
    const max = targets.reduce((m, v) => Math.max(m, v), 0);
    return max + BITMAP_SPAN_HEADROOM;
  }
}
