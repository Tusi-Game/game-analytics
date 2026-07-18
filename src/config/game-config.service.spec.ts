import { DataSource } from 'typeorm';
import { GameConfigService, GAME_CONFIG_DEFAULTS } from './game-config.service';
import type { GameConfig } from '../common/contracts/config';

/**
 * Per-game §6 config reader (T-01.42). Proves forward-only reads: a per-game knob
 * overrides the default; a boolean knob falls back to the §6 default; the read is
 * cached (no repeat DB read within TTL).
 */

function fakeDataSource(config: GameConfig, counter: { finds: number }): DataSource {
  return {
    getRepository: () => ({
      findOne: async () => {
        counter.finds += 1;
        return { config };
      },
    }),
  } as unknown as DataSource;
}

describe('GameConfigService', () => {
  it('reads a numeric per-game knob override', async () => {
    const c = { finds: 0 };
    const svc = new GameConfigService(fakeDataSource({ event_name_cap_per_game: 3 }, c), 30_000);
    expect(await svc.getNumber('game-42', 'event_name_cap_per_game')).toBe(3);
  });

  it('returns undefined for a missing numeric knob (caller supplies the default)', async () => {
    const c = { finds: 0 };
    const svc = new GameConfigService(fakeDataSource({}, c), 30_000);
    expect(await svc.getNumber('game-42', 'event_name_cap_per_game')).toBeUndefined();
  });

  it('boolean knob falls back to the §6 default when unset', async () => {
    const c = { finds: 0 };
    const svc = new GameConfigService(fakeDataSource({}, c), 30_000);
    expect(await svc.getBoolean('game-42', 'cold_storage_enabled')).toBe(GAME_CONFIG_DEFAULTS.cold_storage_enabled);
  });

  it('caches within TTL (single DB read for repeated getters)', async () => {
    const c = { finds: 0 };
    const svc = new GameConfigService(fakeDataSource({ top_n_events: 5 }, c), 30_000);
    await svc.getNumber('game-42', 'top_n_events');
    await svc.getNumber('game-42', 'top_n_events');
    await svc.getBoolean('game-42', 'drop_counter_visible');
    expect(c.finds).toBe(1);
  });

  it('invalidate() forces a re-read', async () => {
    const c = { finds: 0 };
    const svc = new GameConfigService(fakeDataSource({ top_n_events: 5 }, c), 30_000);
    await svc.getNumber('game-42', 'top_n_events');
    svc.invalidate('game-42');
    await svc.getNumber('game-42', 'top_n_events');
    expect(c.finds).toBe(2);
  });
});
