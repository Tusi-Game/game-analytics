import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { ReadModelService } from './read-model.service';
import { ReadModelController } from './read-model.controller';

/**
 * Dashboard bounded context — the JSON read model consumed by the panel. Unit 3
 * adds the thin live-vs-historical merge ({@link ReadModelService}) + a read
 * endpoint stub ({@link ReadModelController}); the full panel is spec 012.
 */
@Module({
  imports: [CommonModule, DatabaseModule, RedisModule],
  controllers: [ReadModelController],
  providers: [ReadModelService],
  exports: [ReadModelService],
})
export class DashboardModule {}
