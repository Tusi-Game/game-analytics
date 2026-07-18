/**
 * Per-game §6 config knob reader (T-01.42).
 *
 * Reads the `GAME.config` JSON blob for a game and exposes the §6 knobs with
 * FORWARD-ONLY semantics: a knob's value is read AT INGEST TIME, never applied
 * retroactively (011-operator-admin config-effective-time rule). This service is
 * a pure READER — 011 owns the write path. A short in-process cache avoids a
 * Postgres read per event; the cache TTL is well under any human config-change
 * cadence, so "forward-only at ingest" holds.
 *
 * The set-once guard for `reporting_offset` (data-exists hard-block) is phase-10's
 * to enforce; this service only READS the offset consistently (DARK-SPOT #4:
 * platform-level offset from env, per-game overrides are not a 002 concern).
 *
 * §6 knob defaults (spec §6):
 *   event_name_cap_per_game   500   forward-only
 *   property_key_cap_per_event 50   forward-only
 *   top_n_events               10   display-only
 *   dedup_window_hours         24   inherited global
 *   day_seal_grace_hours       48   inherited global
 *   flush_interval_seconds    300   inherited global
 *   cold_storage_enabled      true  inherited global
 *   drop_counter_visible      true  display-only
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { GameEntity } from '../database/entities/game.entity';
import type { GameConfig } from '../common/contracts/config';

/** DI token for the config-cache TTL (ms). Tests inject 0 to disable caching. */
export const GAME_CONFIG_CACHE_TTL_MS = 'GAME_CONFIG_CACHE_TTL_MS';

/** The §6 knob defaults (forward-only reads fall back to these). */
export const GAME_CONFIG_DEFAULTS = {
  event_name_cap_per_game: 500,
  property_key_cap_per_event: 50,
  top_n_events: 10,
  dedup_window_hours: 24,
  day_seal_grace_hours: 48,
  flush_interval_seconds: 300,
  cold_storage_enabled: true,
  drop_counter_visible: true,
  // Ops-envelope knobs (§5/§7.7, T-00.79). All forward-only.
  // Per-game ingest rate cap (events/sec); 0 = unlimited (ops-envelope §5).
  ingest_events_per_sec_cap: 200,
  // GDPR raw expiry (S3-side) in days; ≤30 = strictest reading (§7.3).
  raw_retention_days: 90,
  // Purchase-idempotency erasure mode: `detach` (default, keeps money dedup) or
  // `delete` (operator accepts the §F double-count risk) (§7.7).
  erasure_purchase_mode: 'detach',
  // Enable the offline strict raw-rewrite tool (operator-run, never automatic).
  strict_raw_rewrite: false,
  // 003-sessions knobs (§6). All forward-only.
  session_inactivity_timeout_min: 30,
  session_max_duration_cap_min: 720,
  session_min_duration_ms: 0,
  // 005-retention knobs (§6). Targets forward-only (widening); min-cohort display-only.
  retention_day_targets: [1, 7, 30],
  retention_min_cohort_size: 30,
  // 004-economy knobs (§7). APPENDED additively — no collision with the above.
  //  - top_n_reasons: retroactive display re-rank over stored per-reason totals.
  //  - ratio_min_events: display-only low-volume mask on sink_ratio (per-leg count).
  //  - currency_allowlist: empty = accept-all (auto-register); forward-only.
  //  - currency_cap_per_game: distinct-currency budget; over-cap → `other` (R3).
  //  - depth_capture_mode: 'full' = depth ON (≈ spec `last_known_balance`); 'off' =
  //    depth OFF. Reconciles the config-contract enum ['off','shallow','full'] with
  //    spec §7 ['last_known_balance','off'] — see EconomyConfigService.
  economy_top_n_reasons: 10,
  economy_ratio_min_events: 100,
  economy_currency_allowlist: [],
  economy_currency_cap_per_game: 500,
  economy_depth_capture_mode: 'full',
  // 006-monetization + 007-derived-kpis knobs (§6/§7). APPENDED additively — every new
  // key has a matching CONFIG_CONTRACTS row (config-contract.ts) (superset invariant).
  //  - monetization_dimensions: active report dims; rebuild-forward (FR-020).
  //  - monetization_dimension_value_cap: per-dim distinct-value budget; over-cap → other.
  //  - payer_tier_rule: fixed dollar thresholds vs lifetime spend (future-reads).
  //  - fx_table: envelope-encrypted FX material (reversible infra secret; future-reads).
  //  - fx_staleness_max_days: as-of staleness cap before parking unconverted.
  //  - whale_min_payers / whale_top_percents: whale cohort read-time knobs.
  //  - mau_window_days / partial_window_mask: derived-KPI window knobs.
  //  - arppu_first_purchase_denominator: first-purchase-conversion denominator base.
  monetization_dimensions: ['level_bucket', 'region', 'in_game_state', 'payer_tier'],
  monetization_dimension_value_cap: 50,
  payer_tier_rule: { dolphin_min: 10, whale_min: 100 },
  fx_staleness_max_days: 7,
  whale_min_payers: 20,
  whale_top_percents: [1, 5, 10],
  mau_window_days: 30,
  partial_window_mask: true,
  arppu_first_purchase_denominator: 'active_users',
} as const;

interface CacheEntry {
  config: GameConfig;
  readAt: number;
}

@Injectable()
export class GameConfigService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(
    private readonly dataSource: DataSource,
    @Optional() @Inject(GAME_CONFIG_CACHE_TTL_MS) ttlMs?: number,
    @Optional() config?: ConfigService,
  ) {
    // WORKER CONFIG CACHE (T-10.26) — the realized effective-time is "within one
    // refresh interval of the admin write". 011 owns the contract; workers READ
    // it. Decision (Unit B): keep 002's IN-PROCESS per-service cache rather than
    // introduce a Redis ops:* snapshot — the in-process cache already bounds the
    // lag to `worker_config_cache_refresh_sec` and adding a Redis snapshot would
    // rewrite every worker's read path (destabilizing 002's hot path for no
    // correctness gain; every forward-only knob re-keys by effective_from PER
    // CELL, not by a global flip, so a per-worker rolling refresh is safe). The
    // config-writer (ConfigAdminService) also calls invalidate() on write, so a
    // change is observed immediately on the writer node and within one refresh on
    // worker nodes. An explicit DI TTL override wins (tests inject 0); otherwise
    // `worker_config_cache_refresh_sec` (default 30s) sets the interval.
    if (typeof ttlMs === 'number' && ttlMs >= 0) {
      this.ttlMs = ttlMs;
    } else {
      const refreshSec = config?.get<number>('WORKER_CONFIG_CACHE_REFRESH_SEC');
      this.ttlMs = typeof refreshSec === 'number' && refreshSec > 0 ? refreshSec * 1000 : 30_000;
    }
  }

  /** Read a game's whole config blob (cached, forward-only). */
  async getConfig(gameId: string): Promise<GameConfig> {
    const cached = this.cache.get(gameId);
    if (cached && Date.now() - cached.readAt < this.ttlMs) {
      return cached.config;
    }
    const row = await this.dataSource.getRepository(GameEntity).findOne({
      where: { gameId },
      select: { config: true },
    });
    const config = row?.config ?? {};
    this.cache.set(gameId, { config, readAt: Date.now() });
    return config;
  }

  /**
   * Read a numeric §6 knob for a game. Returns `undefined` if the game has no
   * override AND the caller wants to fall through to an env/default (the caller
   * decides the fallback so the platform-vs-per-game precedence is explicit).
   */
  async getNumber(gameId: string, key: string): Promise<number | undefined> {
    const config = await this.getConfig(gameId);
    const raw = config[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
      return Number(raw);
    }
    return undefined;
  }

  /**
   * Read a string §6 knob for a game. Returns `undefined` if the game has no
   * (string) override so the caller can fall back to a default explicitly.
   */
  async getString(gameId: string, key: string): Promise<string | undefined> {
    const config = await this.getConfig(gameId);
    const raw = config[key];
    return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
  }

  /** Read a boolean §6 knob for a game, falling back to the §6 default. */
  async getBoolean(gameId: string, key: keyof typeof GAME_CONFIG_DEFAULTS): Promise<boolean> {
    const config = await this.getConfig(gameId);
    const raw = config[key];
    if (typeof raw === 'boolean') {
      return raw;
    }
    const fallback = GAME_CONFIG_DEFAULTS[key];
    return typeof fallback === 'boolean' ? fallback : false;
  }

  /** Invalidate a game's cached config (used by tests / after a known write). */
  invalidate(gameId: string): void {
    this.cache.delete(gameId);
  }
}
