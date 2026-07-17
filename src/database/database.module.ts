import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SnakeNamingStrategy } from './snake-naming.strategy';

/**
 * Postgres connectivity via TypeORM (FR-004).
 *
 * Connection wiring only — the `entities/` directory is empty; later stories add
 * their entities there. `synchronize` is disabled (migrations only, per the
 * migrations/ directory). Column convention is enforced by SnakeNamingStrategy.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.getOrThrow<string>('DB_HOST'),
        port: config.getOrThrow<number>('DB_PORT'),
        username: config.getOrThrow<string>('DB_USER'),
        password: config.getOrThrow<string>('DB_PASSWORD'),
        database: config.getOrThrow<string>('DB_NAME'),
        // Stories register entities via glob so the entities/ dir stays authoritative.
        entities: [__dirname + '/entities/**/*.entity{.ts,.js}'],
        migrations: [__dirname + '/migrations/**/*{.ts,.js}'],
        namingStrategy: new SnakeNamingStrategy(),
        // Never auto-sync schema — migrations own the schema.
        synchronize: false,
        migrationsRun: false,
        autoLoadEntities: true,
      }),
    }),
  ],
})
export class DatabaseModule {}
