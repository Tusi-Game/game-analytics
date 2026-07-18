/**
 * Deterministic per-game×day object reference + local checksum (T-07.4, T-07.7).
 *
 * The object key MIRRORS {@link RawFileService.filePathFor}'s layout —
 * `{game_id}/{day}.rawlog` — under a fixed raw prefix, so:
 *   - it is deterministic per game×day (idempotent overwrite depends on it);
 *   - it is collision-free across games×days;
 *   - it is scoped under a `raw/` prefix so the S3-side raw-expiry sweep can
 *     target ONLY raw day-files and never the PITR backup bucket/prefix (T-07.28).
 */

import { createHash } from 'node:crypto';

/** The fixed S3 key prefix for raw day-file objects (keeps raw ⊥ PITR objects). */
export const RAW_OBJECT_PREFIX = 'raw/';

/**
 * The deterministic object key for a game×corrected-day raw file. Mirrors the
 * local `filePathFor` relative layout under {@link RAW_OBJECT_PREFIX}. The
 * `gameId` is server-derived (trusted, never raw body) but we still reject path
 * separators defensively — same guard as the raw-file writer.
 */
export function objectRefFor(gameId: string, correctedDay: string): string {
  if (gameId.includes('/') || gameId.includes('..') || correctedDay.includes('/') || correctedDay.includes('..')) {
    throw new Error(`[cold-storage] illegal object ref for game "${gameId}" day "${correctedDay}"`);
  }
  return `${RAW_OBJECT_PREFIX}${gameId}/${correctedDay}.rawlog`;
}

/** sha256 hex checksum of a buffer (the integrity_ref checksum algo, v1). */
export function checksumOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
