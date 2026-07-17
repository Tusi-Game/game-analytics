/**
 * Typed environment configuration surface. Mirrors the schema loaded and
 * validated in `src/config/env.ts`. Stories append their own env vars here.
 */
export interface EnvConfig {
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';
  /** Minutes offset from UTC for logical-day boundaries (e.g. 210 for +03:30). */
  REPORTING_OFFSET: number;
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  MINIO_ENDPOINT: string;
  MINIO_PORT: number;
  MINIO_ACCESS_KEY: string;
  MINIO_SECRET_KEY: string;
  MINIO_BUCKET: string;
}

/**
 * Per-game knobs from the GAME.config JSON column.
 *
 * Starts empty and grows as each story appends its own knobs at implementation
 * time. Open-ended by design — indexable by string, values are `unknown`.
 */
export interface GameConfig {
  [key: string]: unknown;
}

/**
 * Registry row describing a single game served by the platform.
 */
export interface GameRegistry {
  game_id: string;
  name: string;
  config: GameConfig;
  registered_at: Date;
}
