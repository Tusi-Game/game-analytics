import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { QueueModule } from '../queue/queue.module';

/**
 * Worker bounded context. Skeleton — no processors yet. Later stories add their
 * BullMQ processors under `processors/` and register them here, consuming from
 * the queues wired in QueueModule.
 */
@Module({
  imports: [CommonModule, DatabaseModule, RedisModule, QueueModule],
})
export class WorkersModule {}
