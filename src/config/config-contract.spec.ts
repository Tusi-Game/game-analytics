import { CONFIG_CONTRACTS, getKnobContract, isAdministeredKnob } from './config-contract';
import { GAME_CONFIG_DEFAULTS } from './game-config.service';

/**
 * Config contract registry (T-10.23/28) — the typed inventory of every §6 knob.
 * 011 SURFACES, never redefines; this registry supersets GAME_CONFIG_DEFAULTS.
 */
describe('config contract registry', () => {
  it('has no duplicate keys', () => {
    const keys = CONFIG_CONTRACTS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('supersets GAME_CONFIG_DEFAULTS (every runtime default is an administered knob)', () => {
    for (const key of Object.keys(GAME_CONFIG_DEFAULTS)) {
      expect(isAdministeredKnob(key)).toBe(true);
    }
  });

  it('includes R12 drop_counter_visible (01 defines, 10 surfaces, 11 reads)', () => {
    const c = getKnobContract('drop_counter_visible');
    expect(c).toBeDefined();
    expect(c?.owner).toBe('002-foundation-ingest');
    expect(c?.effect).toBe('display-only');
  });

  it('marks reporting_offset platform-level + set-once (R13)', () => {
    const c = getKnobContract('reporting_offset');
    expect(c).toBeDefined();
    expect(c?.scope).toBe('platform');
    expect(c?.effect).toBe('set-once');
  });

  it('labels the design.md effect-timing classes correctly', () => {
    // forward-only caps / retroactive read-time / display masks / rebuild-forward
    // / future-reads re-tier — spot-check each class against design.md.
    expect(getKnobContract('event_name_cap_per_game')?.effect).toBe('forward-only');
    expect(getKnobContract('top_n_events')?.effect).toBe('retroactive');
    expect(getKnobContract('mau_window_days')?.effect).toBe('retroactive');
    expect(getKnobContract('whale_min_payers')?.effect).toBe('retroactive');
    expect(getKnobContract('retention_min_cohort_size')?.effect).toBe('display-only');
    expect(getKnobContract('economy_ratio_min_events')?.effect).toBe('display-only');
    expect(getKnobContract('monetization_dimensions')?.effect).toBe('rebuild-forward');
    expect(getKnobContract('payer_tier_rule')?.effect).toBe('future-reads');
    expect(getKnobContract('fx_table')?.effect).toBe('future-reads');
  });

  it('classifies operator_* + worker_config_cache_refresh_sec as platform-level', () => {
    for (const key of [
      'operator_login_max_attempts',
      'operator_lockout_min',
      'operator_mfa_required',
      'operator_session_timeout_min',
      'worker_config_cache_refresh_sec',
    ]) {
      expect(getKnobContract(key)?.scope).toBe('platform');
    }
  });

  it('unknown keys are not administered', () => {
    expect(getKnobContract('made_up_knob')).toBeUndefined();
    expect(isAdministeredKnob('made_up_knob')).toBe(false);
  });
});
