import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';

/**
 * Dashboard bounded context — the JSON read model consumed by the panel.
 * Skeleton — no controllers yet. Later stories add read-model endpoints here.
 */
@Module({
  imports: [CommonModule, DatabaseModule, RedisModule],
})
export class DashboardModule {}
