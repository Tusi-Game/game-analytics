import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import { AppModule } from './app.module';
import { AppValidationPipe } from './common/pipes/validation.pipe';
import { configurePanel } from './panel/panel-bootstrap';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('Bootstrap');

  // Global validation pipe. (Exception filter + logging interceptor are
  // registered globally in CommonModule via APP_FILTER / APP_INTERCEPTOR.)
  app.useGlobalPipes(new AppValidationPipe());

  // Ingest batches are legitimately large — raise the JSON body limit above the
  // Express 100 kb default so a full batch is not rejected with 413. The queue
  // depth / rate-limit shedding (Unit 4) governs load, not the parser limit.
  app.use(express.json({ limit: process.env.INGEST_BODY_LIMIT ?? '10mb' }));

  // Panel view engine (Nunjucks) + static assets — shared with the e2e harness
  // via configurePanel so both runtimes wire the panel identically.
  configurePanel(app);

  // Dev-only CORS — a reverse proxy handles this in prod.
  app.enableCors();

  // Flush ioredis / BullMQ connections cleanly on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT') ?? 3000;
  await app.listen(port);
  logger.log(`Analytics platform listening on port ${port}`);
}

void bootstrap();
