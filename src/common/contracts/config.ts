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
  /** Root directory for write-ahead raw day-files (bridge 01.5). */
  RAW_FILE_DIR: string;
  /** Platform-level cold-storage toggle (bridge 01.5 §7). Off ⇒ step 4 no-op. */
  COLD_STORAGE_ENABLED: boolean;
  /** Platform default per-game distinct-event-name cap (§6, R3 other-overflow). */
  EVENT_NAME_CAP_PER_GAME: number;
  /** Flush sweep cadence in seconds (§6 inherited global, default 300). */
  FLUSH_INTERVAL_SECONDS: number;
  /** Ingest worker concurrency (parallel batches). */
  INGEST_WORKER_CONCURRENCY: number;
  MINIO_ENDPOINT: string;
  MINIO_PORT: number;
  MINIO_ACCESS_KEY: string;
  MINIO_SECRET_KEY: string;
  MINIO_BUCKET: string;
  /**
   * Redis `maxmemory` byte cap the door watermark brakes against (ops-envelope
   * §3, ≈ 3.8 GB). MUST match the `--maxmemory` in docker-compose so the
   * fast-ack door refuses BEFORE `noeviction` OOM. Bytes.
   */
  REDIS_MAXMEMORY_BYTES: number;
  /**
   * Fraction of `REDIS_MAXMEMORY_BYTES` at which the door starts 503-ing
   * (ops-envelope §4, default 0.80 ≈ 3 GB). 0..1.
   */
  MEMORY_WATERMARK_FRACTION: number;
  /**
   * Absolute queue-depth soft limit (ops-envelope §4, ~200k jobs). Whichever of
   * this or the memory watermark trips first sheds with 503.
   */
  QUEUE_DEPTH_WATERMARK: number;
  /** 503/429 Retry-After header value, seconds (ops-envelope §4/§5). */
  RETRY_AFTER_SECONDS: number;
  /**
   * Platform default per-game sustained ingest rate cap in events/sec
   * (ops-envelope §5 `ingest_events_per_sec_cap`, default 200). Per-game
   * overrides live in `GAME.config`.
   */
  INGEST_EVENTS_PER_SEC_CAP: number;
  /**
   * Token-bucket burst allowance in events (ops-envelope §5, default 5000) —
   * absorbs an offline client flushing a multi-thousand-event buffer.
   */
  INGEST_RATE_BURST_EVENTS: number;
  /**
   * Master key (base64/hex/utf8) for envelope-encryption of reversible secrets,
   * held OUTSIDE Postgres (env var / Docker secret / file mount) — a DB dump
   * yields ciphertext only (FR-029, ops-envelope §9). Empty ⇒ encryption
   * disabled (dev). Never commit a real value.
   */
  SECRET_MASTER_KEY: string;
  /**
   * When true the ingest API refuses plain-HTTP bearer auth unless
   * `X-Forwarded-Proto: https` is present (the reverse proxy terminated TLS).
   * FR-029 / ops-envelope §9. Default true in production.
   */
  REQUIRE_TLS: boolean;
  /**
   * Comma-separated allowed Origins for web (client-provenance) builds. Empty ⇒
   * no Origin restriction (server builds, dev). ops-envelope §9 Origin check.
   */
  ALLOWED_ORIGINS: string;
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
