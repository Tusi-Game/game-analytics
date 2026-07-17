import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { QueueModule } from '../queue/queue.module';
import { IngestController } from './ingest.controller';

/**
 * Ingest bounded context. Skeleton — hosts the placeholder `POST /v1/events`
 * front door. Spec 002 fills in validation, routing, dedup, and enqueue.
 */
@Module({
  imports: [CommonModule, DatabaseModule, RedisModule, QueueModule],
  controllers: [IngestController],
})
export class IngestModule {}
