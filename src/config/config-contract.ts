/**
 * Config contract registry (T-10.23, T-10.28) — the typed inventory of EVERY §6
 * knob across the whole platform: every metric story (002…008), the ops-envelope,
 * and 011 itself.
 *
 * 011 SURFACES, never redefines a knob's semantics (design.md §Config
 * administration). This registry is the single source of truth the config-write
 * validation (T-10.24/25) checks new values against, and the effect-timing label
 * the admin surface shows (T-10.28). It supersets the read-side defaults in
 * `game-config.service.ts` (GAME_CONFIG_DEFAULTS) — those are the runtime
 * fallbacks; this is the full administered inventory + value contracts.
 *
 * Design invariants encoded here:
 *  - `scope`: `platform` knobs come from env and are NOT per-game GAME.config
 *    writes (reporting_offset, operator_*, worker_config_cache_refresh_sec). The
 *    admin config-write path REFUSES a per-game write of a platform knob.
 *  - `effect`: the realized effective-time class per design.md §Config-effective-
 *    time. `set-once` (reporting_offset) carries the R13 data-exists hard-block.
 *  - `contract`: the value shape/range/enum a set is validated against; an
 *    out-of-contract value is rejected BEFORE any write or audit (T-10.43).
 */

/** Owner story of a knob (design.md inventory "Owner" column). */
export type KnobOwner =
  | '002-foundation-ingest'
  | '003-sessions'
  | '004-economy'
  | '005-retention'
  | '006-monetization'
  | '007-derived-kpis'
  | '008-cold-storage'
  | 'ops-envelope'
  | '011-operator-admin'
  | 'foundation/platform';

/**
 * Realized effect-timing class (design.md §Config-effective-time + inventory
 * "Effect timing" column). Labels how a change to the knob is realized:
 *  - `forward-only`     : re-keys/caps only cells written after effective_from;
 *                         sealed cells keep the old value (the general rule).
 *  - `retroactive`      : recomputed at read time (top_n/mau_window/whale_min/…);
 *                         no re-key, the read simply uses the current value.
 *  - `display-only`     : a presentation/sample-size mask; never touches stored
 *                         aggregates (min_cohort, ratio_min, timezone offset).
 *  - `rebuild-forward`  : re-keys the dimension going forward, per-period coverage
 *                         reported from CONFIG_AUDIT (monetization_dimensions).
 *  - `future-reads`     : re-tiers/re-normalizes future reads at zero migration,
 *                         never restamps a sealed cell (payer_tier_rule, fx_*).
 *  - `set-once`         : correctness-bearing, install-time only; HARD-BLOCKED
 *                         once durable data exists (reporting_offset, R13).
 *  - `next-session`     : takes effect on the next operator session / next cache
 *                         refresh (operator_* / worker_config_cache_refresh_sec).
 */
export type EffectTiming =
  'forward-only' | 'retroactive' | 'display-only' | 'rebuild-forward' | 'future-reads' | 'set-once' | 'next-session';

/** Where the knob lives: a per-game GAME.config write, or a platform-level env. */
export type KnobScope = 'per-game' | 'platform';

/** The value contract a set is validated against (T-10.24). */
export type ValueContract =
  | { readonly type: 'int'; readonly min?: number; readonly max?: number }
  | { readonly type: 'number'; readonly min?: number; readonly max?: number }
  | { readonly type: 'boolean' }
  | { readonly type: 'string'; readonly maxLength?: number }
  /** A closed set of allowed string values. */
  | { readonly type: 'enum'; readonly values: readonly string[] }
  /** A homogeneous array (each element validated against `element`). */
  | { readonly type: 'array'; readonly element: ValueContract; readonly maxItems?: number }
  /** An opaque JSON object (structure owned by the owner story; presence-only). */
  | { readonly type: 'object' };

/** One knob's full contract row (design.md inventory + effect-timing). */
export interface KnobContract {
  readonly key: string;
  readonly owner: KnobOwner;
  readonly effect: EffectTiming;
  readonly scope: KnobScope;
  readonly contract: ValueContract;
  /** One-line human note surfaced by the admin UI (effect-timing explanation). */
  readonly note: string;
}

/**
 * The full §6 knob inventory. Order mirrors design.md's inventory table. Every
 * per-game default in GAME_CONFIG_DEFAULTS has a row here; platform-level knobs
 * (env-sourced) are declared so the admin surface can REFUSE a per-game write.
 */
export const CONFIG_CONTRACTS: readonly KnobContract[] = [
  // ── 002-foundation-ingest ────────────────────────────────────────────────
  {
    key: 'event_name_cap_per_game',
    owner: '002-foundation-ingest',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'int', min: 1, max: 100_000 },
    note: 'Distinct-event-name cap; forward-only (overflow tallied as `other`, R3).',
  },
  {
    key: 'property_key_cap_per_event',
    owner: '002-foundation-ingest',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'int', min: 1, max: 10_000 },
    note: 'Per-event property-key cap; forward-only.',
  },
  {
    key: 'top_n_events',
    owner: '002-foundation-ingest',
    effect: 'retroactive',
    scope: 'per-game',
    contract: { type: 'int', min: 1, max: 1000 },
    note: 'Top-N events surfaced at read; retroactive (recomputed at read).',
  },
  {
    key: 'pii_prop_denylist',
    owner: '002-foundation-ingest',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'array', element: { type: 'string', maxLength: 256 }, maxItems: 10_000 },
    note: 'Default-DENY PII property denylist; forward-only (ships a non-empty default).',
  },
  {
    key: 'pii_prop_value_scrubber',
    owner: '002-foundation-ingest',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'enum', values: ['off', 'hash', 'redact'] },
    note: 'PII property-value scrubber mode; forward-only (ops-envelope §9).',
  },
  {
    key: 'pii_prop_hash',
    owner: '002-foundation-ingest',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'boolean' },
    note: 'Hash flagged PII properties instead of dropping; forward-only.',
  },
  {
    key: 'dedup_window_hours',
    owner: '002-foundation-ingest',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'int', min: 1, max: 168 },
    note: 'Windowed-dedup horizon (hours); forward-only.',
  },
  {
    key: 'day_seal_grace_hours',
    owner: '002-foundation-ingest',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'int', min: 0, max: 168 },
    note: 'Grace window before a day seals; forward-only.',
  },
  {
    key: 'flush_interval_seconds',
    owner: '002-foundation-ingest',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'int', min: 5, max: 3600 },
    note: 'Redis→Postgres flush cadence (seconds); forward-only.',
  },
  {
    // R12: 01 (002) defines drop_counter_visible, 10 (011) SURFACES it, 11 reads.
    key: 'drop_counter_visible',
    owner: '002-foundation-ingest',
    effect: 'display-only',
    scope: 'per-game',
    contract: { type: 'boolean' },
    note: 'Show the drop/exception counter in the panel; display-only (R12).',
  },

  // ── 003-sessions ─────────────────────────────────────────────────────────
  {
    key: 'session_inactivity_timeout_min',
    owner: '003-sessions',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'int', min: 1, max: 1440 },
    note: 'Session inactivity timeout; forward-only (never re-buckets emitted sessions).',
  },
  {
    key: 'session_max_duration_cap_min',
    owner: '003-sessions',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'int', min: 1, max: 10_080 },
    note: 'Session max-duration cap; forward-only.',
  },
  {
    key: 'session_min_duration_ms',
    owner: '003-sessions',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'int', min: 0, max: 600_000 },
    note: 'Session min-duration floor (ms); forward-only.',
  },

  // ── 004-economy ──────────────────────────────────────────────────────────
  {
    key: 'economy_currency_allowlist',
    owner: '004-economy',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'array', element: { type: 'string', maxLength: 32 }, maxItems: 1000 },
    note: 'Allowed economy currencies; forward-only.',
  },
  {
    key: 'economy_depth_capture_mode',
    owner: '004-economy',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'enum', values: ['off', 'shallow', 'full'] },
    note: 'Economy depth-capture mode; forward-only.',
  },
  {
    key: 'economy_top_n_reasons',
    owner: '004-economy',
    effect: 'retroactive',
    scope: 'per-game',
    contract: { type: 'int', min: 1, max: 1000 },
    note: 'Top-N sink/source reasons; retroactive (recomputed at read).',
  },
  {
    key: 'economy_ratio_min_events',
    owner: '004-economy',
    effect: 'display-only',
    scope: 'per-game',
    contract: { type: 'int', min: 0, max: 1_000_000 },
    note: 'Sink-ratio low-volume display guard; display-only sample-size mask.',
  },
  {
    // Distinct-currency budget per game; over-cap currencies collapse to the `other`
    // overflow bucket (KEPT + counted, R3). Forward-only (never retro-collapses
    // sealed cells) — mirrors event_name_cap_per_game's posture for currencies.
    key: 'economy_currency_cap_per_game',
    owner: '004-economy',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'int', min: 1, max: 100_000 },
    note: 'Distinct-currency cap; forward-only (overflow tallied as `other`, R3/§H-4).',
  },
  {
    key: 'level_bucket_boundaries',
    owner: '004-economy',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'array', element: { type: 'int', min: 0 }, maxItems: 1000 },
    note: 'Level-bucket boundaries; forward-only.',
  },

  // ── 005-retention ────────────────────────────────────────────────────────
  {
    key: 'retention_day_targets',
    owner: '005-retention',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'array', element: { type: 'int', min: 0, max: 3650 }, maxItems: 100 },
    note: 'Retention day targets (D1/D7/…); forward-only (widening annotated "tracking begins…").',
  },
  {
    key: 'retention_min_cohort_size',
    owner: '005-retention',
    effect: 'display-only',
    scope: 'per-game',
    contract: { type: 'int', min: 0, max: 1_000_000 },
    note: 'Min cohort size before a retention cell shows; display-only sample-size mask.',
  },

  // ── foundation / platform ────────────────────────────────────────────────
  {
    // R13: correctness-bearing, set-once at install. HARD-BLOCKED once data
    // exists (see ConfigAdminService + DataExistsService). Platform-level (env
    // REPORTING_OFFSET) — the per-game admin write path REFUSES it outright.
    key: 'reporting_offset',
    owner: 'foundation/platform',
    effect: 'set-once',
    scope: 'platform',
    contract: { type: 'int', min: -720, max: 840 },
    note: 'Platform logical-day offset (minutes). SET-ONCE at install; changing it after data exists is a forbidden forward-rebuild (R13/P8).',
  },

  // ── 006-monetization ─────────────────────────────────────────────────────
  {
    key: 'monetization_dimensions',
    owner: '006-monetization',
    effect: 'rebuild-forward',
    scope: 'per-game',
    contract: { type: 'array', element: { type: 'string', maxLength: 64 }, maxItems: 64 },
    note: 'Monetization report dimensions; rebuild-forward (FR-020) — re-keys cells after effective_from, sealed cells keep old encoding.',
  },
  {
    key: 'monetization_dimension_value_cap',
    owner: '006-monetization',
    effect: 'rebuild-forward',
    scope: 'per-game',
    contract: { type: 'int', min: 1, max: 100_000 },
    note: 'Per-dimension distinct-value cap; rebuild-forward.',
  },
  {
    key: 'payer_tier_rule',
    owner: '006-monetization',
    effect: 'future-reads',
    scope: 'per-game',
    contract: { type: 'object' },
    note: 'Payer-tier thresholds; re-tiers FUTURE reads at zero migration (spine stores spend, not tier — Q3); never restamps a sealed cell.',
  },
  {
    key: 'fx_table',
    owner: '006-monetization',
    effect: 'future-reads',
    scope: 'per-game',
    contract: { type: 'object' },
    note: 'FX-rate table material; affects UNSEALED re-normalization only (reversible infra secret — envelope-encrypted).',
  },
  {
    key: 'fx_staleness_max_days',
    owner: '006-monetization',
    effect: 'future-reads',
    scope: 'per-game',
    contract: { type: 'int', min: 0, max: 3650 },
    note: 'Max FX-rate staleness (days); affects unsealed re-normalization only.',
  },

  // ── 007-derived-kpis ─────────────────────────────────────────────────────
  {
    key: 'mau_window_days',
    owner: '007-derived-kpis',
    effect: 'retroactive',
    scope: 'per-game',
    contract: { type: 'int', min: 1, max: 3650 },
    note: 'MAU rolling-window (days); retroactive read-time window.',
  },
  {
    key: 'whale_min_payers',
    owner: '007-derived-kpis',
    effect: 'retroactive',
    scope: 'per-game',
    contract: { type: 'int', min: 1, max: 1_000_000 },
    note: 'Whale-cohort min-payers threshold; retroactive read-time window.',
  },

  // ── 008-cold-storage ─────────────────────────────────────────────────────
  {
    key: 'cold_storage_enabled',
    owner: '008-cold-storage',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'boolean' },
    note: 'Cold-storage upload toggle; forward-only (never rewrites existing files).',
  },
  {
    key: 'cold_storage_bucket',
    owner: '008-cold-storage',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'string', maxLength: 256 },
    note: 'Cold-storage bucket name; forward-only.',
  },
  {
    key: 'cold_storage_credentials',
    owner: '008-cold-storage',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'string', maxLength: 8192 },
    note: 'Cold-storage (S3) write credentials; forward-only — reversible infra secret, envelope-encrypted (NEVER plaintext in GAME.config).',
  },
  {
    key: 'cold_storage_local_retention_days',
    owner: '008-cold-storage',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'int', min: 0, max: 3650 },
    note: 'Local raw-file retention before cold-storage prune (days); forward-only.',
  },
  {
    key: 'cold_storage_upload_schedule',
    owner: '008-cold-storage',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'string', maxLength: 256 },
    note: 'Cold-storage upload schedule; forward-only.',
  },
  {
    key: 'raw_file_compression',
    owner: '008-cold-storage',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'enum', values: ['none', 'gzip', 'zstd'] },
    note: 'Raw-file codec; forward-only (never rewrites existing files).',
  },

  // ── ops-envelope (Q7 / rate) ─────────────────────────────────────────────
  {
    key: 'raw_retention_days',
    owner: 'ops-envelope',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'int', min: 0, max: 3650 },
    note: 'Raw S3-side retention (days); forward-only.',
  },
  {
    key: 'erasure_purchase_mode',
    owner: 'ops-envelope',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'enum', values: ['detach', 'delete'] },
    note: 'Purchase-idempotency erasure mode; governs FUTURE erasure jobs (§7.7).',
  },
  {
    key: 'strict_raw_rewrite',
    owner: 'ops-envelope',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'boolean' },
    note: 'Enable the offline strict raw-rewrite tool (operator-run, never automatic).',
  },
  {
    key: 'ingest_events_per_sec_cap',
    owner: 'ops-envelope',
    effect: 'forward-only',
    scope: 'per-game',
    contract: { type: 'int', min: 0, max: 10_000_000 },
    note: 'Per-game sustained ingest rate cap (events/sec); forward-only (breach → 429 + rate_limited tally). 0 = unlimited.',
  },

  // ── 011-operator-admin (platform-level account + cache knobs) ─────────────
  {
    key: 'operator_login_max_attempts',
    owner: '011-operator-admin',
    effect: 'next-session',
    scope: 'platform',
    contract: { type: 'int', min: 1, max: 100 },
    note: 'Failed logins before lockout; platform-level (env), takes effect next login.',
  },
  {
    key: 'operator_lockout_min',
    owner: '011-operator-admin',
    effect: 'next-session',
    scope: 'platform',
    contract: { type: 'int', min: 1, max: 1440 },
    note: 'Lockout backoff (minutes); platform-level (env).',
  },
  {
    key: 'operator_mfa_required',
    owner: '011-operator-admin',
    effect: 'next-session',
    scope: 'platform',
    contract: { type: 'boolean' },
    note: 'Require TOTP MFA at operator login; platform-level (env).',
  },
  {
    key: 'operator_session_timeout_min',
    owner: '011-operator-admin',
    effect: 'next-session',
    scope: 'platform',
    contract: { type: 'int', min: 1, max: 10_080 },
    note: 'Operator session idle timeout (minutes); platform-level (env), takes effect next session.',
  },
  {
    key: 'worker_config_cache_refresh_sec',
    owner: '011-operator-admin',
    effect: 'next-session',
    scope: 'platform',
    contract: { type: 'int', min: 1, max: 3600 },
    note: 'Worker config-cache refresh interval (seconds); platform-level, takes effect next cache refresh.',
  },
] as const;

/** Index the inventory by key for O(1) contract lookup. */
const CONTRACTS_BY_KEY: ReadonlyMap<string, KnobContract> = new Map(CONFIG_CONTRACTS.map((c) => [c.key, c]));

/** Look up a knob's contract by key, or `undefined` if it is not administered. */
export function getKnobContract(key: string): KnobContract | undefined {
  return CONTRACTS_BY_KEY.get(key);
}

/** True iff `key` is a registered administered knob. */
export function isAdministeredKnob(key: string): boolean {
  return CONTRACTS_BY_KEY.has(key);
}
