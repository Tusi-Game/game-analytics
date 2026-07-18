import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from './snake-naming.strategy';

/**
 * Standalone TypeORM DataSource for the CLI (migration:run / generate / revert).
 *
 * This mirrors the runtime connection settings in `database.module.ts` but is a
 * plain `DataSource` the TypeORM CLI can import. Entity and migration globs are
 * the SAME authoritative directories the module uses, so a migration generated
 * here matches what the app loads. `synchronize` is permanently false —
 * migrations own the schema.
 *
 * Reads connection settings straight from `process.env` (the CLI runs outside
 * Nest DI). Run via the `migration:*` npm scripts.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER ?? 'analytics',
  password: process.env.DB_PASSWORD ?? 'analytics',
  database: process.env.DB_NAME ?? 'analytics',
  entities: [__dirname + '/entities/**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/migrations/**/*{.ts,.js}'],
  namingStrategy: new SnakeNamingStrategy(),
  synchronize: false,
  migrationsRun: false,
});
