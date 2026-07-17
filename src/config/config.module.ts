import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { envConfig } from './env';

/**
 * Wraps `@nestjs/config` with our typed, self-validating `envConfig` loader.
 * Global so `ConfigService` is injectable everywhere. The loader throws at boot
 * on missing/malformed keys (fail fast — FR-003).
 */
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [envConfig],
    }),
  ],
})
export class ConfigModule {}
