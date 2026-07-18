import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { SessionsModule } from '../sessions/sessions.module';
import { EconomyModule } from '../economy/economy.module';
import { MonetizationModule } from '../monetization/monetization.module';
import { ColdStorageModule } from '../cold-storage/cold-storage.module';
import { ReadModelService } from './read-model.service';
import { ExceptionReadService } from './exception-read.service';
import { ReadModelController } from './read-model.controller';
import { OperatorSessionService } from '../operator/operator-session.service';
import { OperatorSessionGuard } from '../operator/operator-session.guard';

/**
 * Dashboard bounded context — the JSON read model consumed by the panel. Unit 3
 * adds the thin live-vs-historical merge ({@link ReadModelService}) + a read
 * endpoint stub ({@link ReadModelController}); the full panel is spec 012.
 *
 * 003-sessions/005-retention add session + retention read surfaces via the
 * SessionReadService / RetentionReadService exported by {@link SessionsModule}.
 */
@Module({
  imports: [
    CommonModule,
    DatabaseModule,
    RedisModule,
    SessionsModule,
    EconomyModule,
    MonetizationModule,
    // 008-cold-storage: exports UploadStatusReadModel for the ops upload-status
    // dashboard surface (appended to ReadModelController).
    ColdStorageModule,
  ],
  controllers: [ReadModelController],
  providers: [
    ReadModelService,
    ExceptionReadService,
    // The real bearer OperatorSessionGuard (011) now guards /v1/dashboard/* — the
    // dead common/ skeleton is retired. The guard + its Redis-backed session store
    // depend only on RedisModule (imported above) + the global ConfigService, so
    // they are provided here directly, avoiding a DashboardModule↔OperatorModule
    // import cycle (OperatorModule already imports DashboardModule).
    OperatorSessionService,
    OperatorSessionGuard,
  ],
  exports: [ReadModelService, ExceptionReadService],
})
export class DashboardModule {}
