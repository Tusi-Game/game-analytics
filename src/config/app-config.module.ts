import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { GameConfigService, GAME_CONFIG_CACHE_TTL_MS } from './game-config.service';

/**
 * Per-game §6 config module (T-01.42). Provides {@link GameConfigService} — the
 * forward-only `GAME.config` knob reader — globally so ingest + worker read the
 * same cached view. The env-var config (`ConfigModule` in `config.module.ts`) is
 * separate and already global; this module adds the DB-backed per-game knobs.
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [
    GameConfigService,
    // Default cache TTL (ms). Overridable per test via this token.
    { provide: GAME_CONFIG_CACHE_TTL_MS, useValue: 30_000 },
  ],
  exports: [GameConfigService],
})
export class AppConfigModule {}
