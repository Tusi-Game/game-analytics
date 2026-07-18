import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { SessionsModule } from '../sessions/sessions.module';
import { EconomyModule } from '../economy/economy.module';
import { ReadModelService } from './read-model.service';
import { ReadModelController } from './read-model.controller';

/**
 * Dashboard bounded context — the JSON read model consumed by the panel. Unit 3
 * adds the thin live-vs-historical merge ({@link ReadModelService}) + a read
 * endpoint stub ({@link ReadModelController}); the full panel is spec 012.
 *
 * 003-sessions/005-retention add session + retention read surfaces via the
 * SessionReadService / RetentionReadService exported by {@link SessionsModule}.
 */
@Module({
  imports: [CommonModule, DatabaseModule, RedisModule, SessionsModule, EconomyModule],
  controllers: [ReadModelController],
  providers: [ReadModelService],
  exports: [ReadModelService],
})
export class DashboardModule {}
