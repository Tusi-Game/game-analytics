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

function parseFloatStrict(key: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`[config] Environment variable ${key} must be a finite number, got: "${raw}"`);
  }
  return n;
}

function parseBool(key: string, raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'on' || v === 'yes') {
    return true;
  }
  if (v === 'false' || v === '0' || v === 'off' || v === 'no') {
    return false;
  }
  throw new Error(`[config] ${key} must be a boolean (true/false), got: "${raw}"`);
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
    RAW_FILE_DIR: optionalEnv('RAW_FILE_DIR', './raw'),
    COLD_STORAGE_ENABLED: parseBool('COLD_STORAGE_ENABLED', optionalEnv('COLD_STORAGE_ENABLED', 'true')),
    EVENT_NAME_CAP_PER_GAME: parseIntStrict('EVENT_NAME_CAP_PER_GAME', optionalEnv('EVENT_NAME_CAP_PER_GAME', '500')),
    FLUSH_INTERVAL_SECONDS: parseIntStrict('FLUSH_INTERVAL_SECONDS', optionalEnv('FLUSH_INTERVAL_SECONDS', '300')),
    INGEST_WORKER_CONCURRENCY: parseIntStrict(
      'INGEST_WORKER_CONCURRENCY',
      optionalEnv('INGEST_WORKER_CONCURRENCY', '4'),
    ),
    MINIO_ENDPOINT: optionalEnv('MINIO_ENDPOINT', 'localhost'),
    MINIO_PORT: parseIntStrict('MINIO_PORT', optionalEnv('MINIO_PORT', '9000')),
    MINIO_ACCESS_KEY: optionalEnv('MINIO_ACCESS_KEY', 'minioadmin'),
    MINIO_SECRET_KEY: optionalEnv('MINIO_SECRET_KEY', 'minioadmin'),
    MINIO_BUCKET: optionalEnv('MINIO_BUCKET', 'analytics-raw'),
    // Backpressure / rate-limit envelope (ops-envelope §3–§5). Default cap is
    // ≈ 3.8 GB to match docker-compose's `--maxmemory 3800mb`.
    REDIS_MAXMEMORY_BYTES: parseIntStrict(
      'REDIS_MAXMEMORY_BYTES',
      optionalEnv('REDIS_MAXMEMORY_BYTES', String(3800 * 1024 * 1024)),
    ),
    MEMORY_WATERMARK_FRACTION: parseFloatStrict(
      'MEMORY_WATERMARK_FRACTION',
      optionalEnv('MEMORY_WATERMARK_FRACTION', '0.8'),
    ),
    QUEUE_DEPTH_WATERMARK: parseIntStrict('QUEUE_DEPTH_WATERMARK', optionalEnv('QUEUE_DEPTH_WATERMARK', '200000')),
    RETRY_AFTER_SECONDS: parseIntStrict('RETRY_AFTER_SECONDS', optionalEnv('RETRY_AFTER_SECONDS', '5')),
    INGEST_EVENTS_PER_SEC_CAP: parseIntStrict(
      'INGEST_EVENTS_PER_SEC_CAP',
      optionalEnv('INGEST_EVENTS_PER_SEC_CAP', '200'),
    ),
    INGEST_RATE_BURST_EVENTS: parseIntStrict(
      'INGEST_RATE_BURST_EVENTS',
      optionalEnv('INGEST_RATE_BURST_EVENTS', '5000'),
    ),
    // Security posture (FR-029, ops-envelope §9). Master key empty ⇒ dev.
    SECRET_MASTER_KEY: optionalEnv('SECRET_MASTER_KEY', ''),
    REQUIRE_TLS: parseBool('REQUIRE_TLS', optionalEnv('REQUIRE_TLS', 'false')),
    ALLOWED_ORIGINS: optionalEnv('ALLOWED_ORIGINS', ''),
    // Operator account hardening (011 §6). All platform-level.
    OPERATOR_SESSION_TIMEOUT_MIN: parseIntStrict(
      'OPERATOR_SESSION_TIMEOUT_MIN',
      optionalEnv('OPERATOR_SESSION_TIMEOUT_MIN', '120'),
    ),
    OPERATOR_LOGIN_MAX_ATTEMPTS: parseIntStrict(
      'OPERATOR_LOGIN_MAX_ATTEMPTS',
      optionalEnv('OPERATOR_LOGIN_MAX_ATTEMPTS', '5'),
    ),
    OPERATOR_LOCKOUT_MIN: parseIntStrict('OPERATOR_LOCKOUT_MIN', optionalEnv('OPERATOR_LOCKOUT_MIN', '15')),
    OPERATOR_MFA_REQUIRED: parseBool('OPERATOR_MFA_REQUIRED', optionalEnv('OPERATOR_MFA_REQUIRED', 'false')),
    WORKER_CONFIG_CACHE_REFRESH_SEC: parseIntStrict(
      'WORKER_CONFIG_CACHE_REFRESH_SEC',
      optionalEnv('WORKER_CONFIG_CACHE_REFRESH_SEC', '30'),
    ),
  };
}
