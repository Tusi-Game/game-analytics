import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { GameEntity } from './database/entities/game.entity';

/**
 * Dev seed runner (T-01.6, FR-015).
 *
 * Creates a minimal GAME row with a fixed SDK key so ingest auth is testable
 * before 011-operator-admin's registration API exists. IDEMPOTENT — safe to
 * re-run: an existing row for the same game_id is left untouched (ON CONFLICT DO
 * NOTHING), so the SDK key stays stable across runs.
 *
 * These constants are the well-known dev credentials the ingest tests and local
 * SDKs authenticate with. They are NOT production values.
 */
const DEV_GAME_ID = 'game-42';
const DEV_GAME_NAME = 'Dev Game 42';
const DEV_SDK_KEY = 'sdk_dev_game42_publickey';

async function seed(): Promise<void> {
  const logger = new Logger('Seed');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const dataSource = app.get(DataSource);
    const result = await dataSource
      .createQueryBuilder()
      .insert()
      .into(GameEntity)
      .values({
        gameId: DEV_GAME_ID,
        name: DEV_GAME_NAME,
        sdkKey: DEV_SDK_KEY,
        serverCredential: null,
        config: {},
        registeredAt: new Date(),
      })
      .orIgnore() // ON CONFLICT DO NOTHING — idempotent, key stays stable.
      .execute();

    // On ON CONFLICT DO NOTHING, Postgres RETURNING yields no rows → result.raw
    // is empty. A fresh insert yields exactly one row. (result.identifiers is
    // unreliable here — it can report a placeholder even on a no-op conflict.)
    const inserted = Array.isArray(result.raw) && result.raw.length > 0;
    logger.log(
      inserted
        ? `Seeded GAME "${DEV_GAME_ID}" with sdk_key "${DEV_SDK_KEY}".`
        : `GAME "${DEV_GAME_ID}" already present — left untouched (idempotent).`,
    );
  } finally {
    await app.close();
  }
}

void seed();
