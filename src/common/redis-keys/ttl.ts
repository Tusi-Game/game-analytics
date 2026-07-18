/**
 * TTL conventions (foundation §2.3), in SECONDS (ioredis EXPIRE unit).
 *
 * These are the platform-wide lifetimes; individual helpers apply them.
 */

/** Dedup markers live a FIXED 24 h — never flushed, always window-bounded. */
export const DEDUP_TTL_SECONDS = 24 * 60 * 60;

/**
 * Open-day buckets live ~72 h from day-end (seal at D_end + 48 h grace, plus a
 * ~24 h expiry margin). Applied to `cnt`/`cnt:exc`/`cnt:rank` day hashes.
 */
export const OPEN_DAY_BUCKET_TTL_SECONDS = 72 * 60 * 60;

/** Cross-worker companion staging (05 only) lives 48 h. */
export const COMPANION_STAGING_TTL_SECONDS = 48 * 60 * 60;

/**
 * Day-less `cat` structures have NO fixed TTL — they never seal and are
 * rehydrated on miss. Exposed as `null` so callers can branch explicitly rather
 * than guessing.
 */
export const CATALOG_TTL_SECONDS = null;
