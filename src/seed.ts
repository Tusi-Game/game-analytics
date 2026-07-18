import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { GameEntity } from './database/entities/game.entity';
import { GameSdkKeyEntity } from './database/entities/game-sdk-key.entity';
import { credentialPrefix, hashCredential } from './operator/credential-hash';
import { AppModule } from './app.module';

/**
 * Dev seed runner (T-01.6, FR-015) — 011-updated.
 *
 * Creates a minimal GAME row and its ONE public `GAME_SDK_KEY` child row (hashed,
 * via the shared `hashCredential` scheme) so ingest auth is testable through the
 * REWRITTEN child-table resolver. IDEMPOTENT — safe to re-run: an existing GAME
 * row is left untouched, and the sdk_key child row is inserted only if its hash
 * is not already present, so the well-known dev key stays stable across runs.
 *
 * `DEV_SDK_KEY` is the well-known dev credential the ingest tests and local SDKs
 * authenticate with. It is NOT a production value. (It keeps its historical
 * spelling rather than the `pk_` scheme so existing dev tooling is unaffected;
 * the resolver keys on the hash, not the prefix.)
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
    const master = process.env.SECRET_MASTER_KEY ?? '';

    const gameResult = await dataSource
      .createQueryBuilder()
      .insert()
      .into(GameEntity)
      .values({
        gameId: DEV_GAME_ID,
        name: DEV_GAME_NAME,
        sdkKey: null,
        serverCredential: null,
        config: {},
        registeredAt: new Date(),
      })
      .orIgnore() // ON CONFLICT DO NOTHING — idempotent, row stays stable.
      .execute();

    const gameInserted = Array.isArray(gameResult.raw) && gameResult.raw.length > 0;

    // Seed the ONE public sdk_key child row (hashed), idempotent by hash.
    const keyHash = hashCredential(master, DEV_SDK_KEY);
    const keyRepo = dataSource.getRepository(GameSdkKeyEntity);
    const existing = await keyRepo.findOne({ where: { keyHash } });
    let keyInserted = false;
    if (!existing) {
      await keyRepo.insert({
        gameId: DEV_GAME_ID,
        keyId: randomUUID(),
        keyPrefix: credentialPrefix(DEV_SDK_KEY),
        keyHash,
        createdAt: new Date(),
        lastUsedAt: null,
        revokedAt: null,
      });
      keyInserted = true;
    }

    logger.log(
      `Seed complete — GAME "${DEV_GAME_ID}" ${gameInserted ? 'inserted' : 'already present'}; ` +
        `sdk_key child ${keyInserted ? 'inserted' : 'already present'} (dev key "${DEV_SDK_KEY}").`,
    );
  } finally {
    await app.close();
  }
}

void seed();
