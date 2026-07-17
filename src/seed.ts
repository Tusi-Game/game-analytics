import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Dev seed runner (placeholder — FR-015). Bootstraps the app context so future
 * seed logic has DI available, then exits. No data is seeded yet.
 */
async function seed(): Promise<void> {
  const logger = new Logger('Seed');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  logger.log('Seed complete — no data yet.');
  await app.close();
}

void seed();
