import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { QueueModule } from '../queue/queue.module';
import { AppConfigModule } from '../config/app-config.module';
import { WorkersModule } from '../workers/workers.module';
import { IngestController } from './ingest.controller';
import { CredentialResolver } from './credential-resolver.service';
import { IngestAuthGuard } from './ingest-auth.guard';
import { MemoryWatermarkService } from './backpressure/memory-watermark.service';
import { RateLimitService } from './backpressure/rate-limit.service';
import { IngestShedder } from './backpressure/ingest-shedder.service';

/**
 * Ingest bounded context (spec 002 Unit 3 + Unit 4). Hosts the `POST /v1/events`
 * front door with real credential→game auth ({@link IngestAuthGuard} +
 * {@link CredentialResolver}), the opaque fast-ack enqueue, and the Unit-4
 * backpressure/rate-limit shedder ({@link IngestShedder}: 503 memory-watermark /
 * queue-depth + 429 per-game token bucket, applied BEFORE ack). Per-event work
 * is worker-side (WorkersModule); the shedder reuses WorkersModule's
 * ExceptionTallyWriter for the arrival-day `rate_limited` tally.
 */
@Module({
  imports: [CommonModule, DatabaseModule, RedisModule, QueueModule, AppConfigModule, WorkersModule],
  controllers: [IngestController],
  providers: [CredentialResolver, IngestAuthGuard, MemoryWatermarkService, RateLimitService, IngestShedder],
  exports: [CredentialResolver],
})
export class IngestModule {}
