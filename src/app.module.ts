import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { QueueModule } from './queue/queue.module';
import { CommonModule } from './common/common.module';
import { SecurityModule } from './security/security.module';
import { IngestModule } from './ingest/ingest.module';
import { WorkersModule } from './workers/workers.module';
import { SessionsModule } from './sessions/sessions.module';
import { EconomyModule } from './economy/economy.module';
import { GdprModule } from './gdpr/gdpr.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { PanelModule } from './panel/panel.module';
import { OperatorModule } from './operator/operator.module';
import { HealthController } from './health/health.controller';

/**
 * Root module. Wires the infrastructure modules and all five bounded contexts.
 * No application logic — imports only (plus the app-level /health endpoint).
 */
@Module({
  imports: [
    ConfigModule,
    AppConfigModule,
    DatabaseModule,
    RedisModule,
    QueueModule,
    CommonModule,
    SecurityModule,
    IngestModule,
    WorkersModule,
    // 003-sessions + 005-retention (combined) — registers the `session` kind's
    // validator/durable/hot triple + sess/act/ret flush plans with the dispatcher
    // seam (additive). MUST come after WorkersModule (which owns the dispatchers).
    SessionsModule,
    // 004-economy — registers the `economy` kind's validator/durable(Noop)/hot
    // triple + eco/bal flush plans with the dispatcher seam (additive). MUST come
    // after WorkersModule (which owns the dispatchers).
    EconomyModule,
    GdprModule,
    DashboardModule,
    PanelModule,
    OperatorModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
