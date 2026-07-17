import type { EnvConfig } from '../common/contracts/config';

/**
 * Env keys with no safe default — the app must fail fast at boot if any is
 * missing. Connection-critical: DB and Redis.
 */
const REQUIRED_KEYS = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'REDIS_HOST', 'REDIS_PORT'] as const;

function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`[config] Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value;
}

function parseIntStrict(key: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(`[config] Environment variable ${key} must be an integer, got: "${raw}"`);
  }
  return n;
}

function parseNodeEnv(raw: string): EnvConfig['NODE_ENV'] {
  if (raw === 'development' || raw === 'production' || raw === 'test') {
    return raw;
  }
  throw new Error(`[config] NODE_ENV must be one of development|production|test, got: "${raw}"`);
}

/**
 * Loads and validates the typed environment configuration. Throws (fails fast)
 * on any missing required key or malformed integer. Registered with
 * `ConfigModule.forRoot({ load: [envConfig] })`.
 */
export function envConfig(): EnvConfig {
  // Fail fast on any missing connection-critical key before parsing.
  for (const key of REQUIRED_KEYS) {
    requireEnv(key);
  }

  return {
    PORT: parseIntStrict('PORT', optionalEnv('PORT', '3000')),
    NODE_ENV: parseNodeEnv(optionalEnv('NODE_ENV', 'development')),
    REPORTING_OFFSET: parseIntStrict('REPORTING_OFFSET', optionalEnv('REPORTING_OFFSET', '0')),
    DB_HOST: requireEnv('DB_HOST'),
    DB_PORT: parseIntStrict('DB_PORT', requireEnv('DB_PORT')),
    DB_USER: requireEnv('DB_USER'),
    DB_PASSWORD: requireEnv('DB_PASSWORD'),
    DB_NAME: requireEnv('DB_NAME'),
    REDIS_HOST: requireEnv('REDIS_HOST'),
    REDIS_PORT: parseIntStrict('REDIS_PORT', requireEnv('REDIS_PORT')),
    MINIO_ENDPOINT: optionalEnv('MINIO_ENDPOINT', 'localhost'),
    MINIO_PORT: parseIntStrict('MINIO_PORT', optionalEnv('MINIO_PORT', '9000')),
    MINIO_ACCESS_KEY: optionalEnv('MINIO_ACCESS_KEY', 'minioadmin'),
    MINIO_SECRET_KEY: optionalEnv('MINIO_SECRET_KEY', 'minioadmin'),
    MINIO_BUCKET: optionalEnv('MINIO_BUCKET', 'analytics-raw'),
  };
}
