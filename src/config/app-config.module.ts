import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { GameConfigService, GAME_CONFIG_CACHE_TTL_MS } from './game-config.service';

/**
 * Per-game §6 config module (T-01.42). Provides {@link GameConfigService} — the
 * forward-only `GAME.config` knob reader — globally so ingest + worker read the
 * same cached view. The env-var config (`ConfigModule` in `config.module.ts`) is
 * separate and already global; this module adds the DB-backed per-game knobs.
 *
 * The cache TTL is the WORKER CONFIG CACHE refresh interval (T-10.26):
 * `worker_config_cache_refresh_sec` (default 30s) — the realized config-effective
 * -time is "within one refresh interval of the admin write" (011 owns the
 * contract; workers read it via this in-process cache, see game-config.service).
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [
    GameConfigService,
    // Cache TTL (ms) = worker_config_cache_refresh_sec * 1000 (T-10.26).
    // Overridable per test via this token.
    {
      provide: GAME_CONFIG_CACHE_TTL_MS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): number => {
        const refreshSec = config.get<number>('WORKER_CONFIG_CACHE_REFRESH_SEC');
        return typeof refreshSec === 'number' && refreshSec > 0 ? refreshSec * 1000 : 30_000;
      },
    },
  ],
  exports: [GameConfigService],
})
export class AppConfigModule {}
