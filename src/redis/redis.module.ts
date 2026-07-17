import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

/**
 * Exports a single configured ioredis client (FR-005). Raw ioredis — no
 * `@nestjs/bullmq` or other wrapper. The same client type backs BullMQ in
 * QueueModule.
 *
 * Global so any module can inject `REDIS_CLIENT` without re-importing.
 * `maxRetriesPerRequest: null` is required for BullMQ blocking commands.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis =>
        new Redis({
          host: config.getOrThrow<string>('REDIS_HOST'),
          port: config.getOrThrow<number>('REDIS_PORT'),
          // Required by BullMQ for blocking operations.
          maxRetriesPerRequest: null,
          // Lazy so the app can boot and expose /health even if Redis is not up yet.
          lazyConnect: true,
        }),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(private readonly moduleRef: ModuleRef) {}

  async onApplicationShutdown(): Promise<void> {
    const client = this.moduleRef.get<Redis>(REDIS_CLIENT, { strict: false });
    if (client) {
      await client.quit();
    }
  }
}
