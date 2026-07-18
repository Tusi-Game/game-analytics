/**
 * Cold-storage §6 config reader (T-07.21) — the story-local view over
 * {@link GameConfigService}. A pure READER (011 owns the write path); every knob
 * is FORWARD-ONLY (read at job time, never applied retroactively).
 *
 * WHY ITS OWN FALLBACKS: `cold_storage_bucket`, `cold_storage_credentials`,
 * `cold_storage_upload_schedule`, and `raw_file_compression` are NOT in
 * `GAME_CONFIG_DEFAULTS` (that table only carries the 002-era knobs +
 * `cold_storage_enabled` + `raw_retention_days`). So this service supplies 008's
 * own fallbacks — schedule = "nightly", codec = "gzip" — and lets
 * bucket/credentials fall through to platform-level env defaults
 * (`MINIO_*`), matching the design's "platform-level default with per-game
 * override" rule.
 *
 * `cold_storage_credentials` is an envelope-encrypted string (reversible infra
 * secret) — this service returns the CIPHERTEXT verbatim; the S3 client decrypts
 * it in-worker (T-07.6). Never plaintext in `GAME.config`.
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GameConfigService } from '../config/game-config.service';

/** Default upload cadence when a game has no `cold_storage_upload_schedule`. */
export const DEFAULT_UPLOAD_SCHEDULE = 'nightly';
/** Default codec when a game has no `raw_file_compression`. */
export const DEFAULT_RAW_CODEC = 'gzip';
/** Default local retention (days) after a confirmed upload before delete. */
export const DEFAULT_LOCAL_RETENTION_DAYS = 0;
/** Default S3-side raw retention (days) — matches GAME_CONFIG_DEFAULTS. */
export const DEFAULT_RAW_RETENTION_DAYS = 90;

/** The resolved §6 knobs for one game (all forward-only, read at job time). */
export interface ColdStorageConfig {
  /** Whether cold storage is enabled for this game (default true). */
  enabled: boolean;
  /** Destination bucket (per-game override → platform `MINIO_BUCKET` default). */
  bucket: string | undefined;
  /** Envelope-encrypted credentials ciphertext (undefined ⇒ use platform env). */
  credentialsCipher: string | undefined;
  /** Local retention before delete-local (days; default 0 = same run). */
  localRetentionDays: number;
  /** S3-side raw retention (days; default 90) — DISTINCT from localRetentionDays. */
  rawRetentionDays: number;
  /** Upload cadence (default "nightly"). */
  uploadSchedule: string;
  /** Raw-file codec (default "gzip"). */
  rawFileCompression: string;
}

@Injectable()
export class ColdStorageConfigService {
  constructor(
    private readonly gameConfig: GameConfigService,
    private readonly config: ConfigService,
  ) {}

  /** Read the full resolved cold-storage config for a game. */
  async forGame(gameId: string): Promise<ColdStorageConfig> {
    const bucket =
      (await this.gameConfig.getString(gameId, 'cold_storage_bucket')) ??
      this.config.get<string>('MINIO_BUCKET') ??
      undefined;
    const credentialsCipher = await this.gameConfig.getString(gameId, 'cold_storage_credentials');
    const localRetentionDays =
      (await this.gameConfig.getNumber(gameId, 'cold_storage_local_retention_days')) ?? DEFAULT_LOCAL_RETENTION_DAYS;
    const rawRetentionDays =
      (await this.gameConfig.getNumber(gameId, 'raw_retention_days')) ?? DEFAULT_RAW_RETENTION_DAYS;
    const uploadSchedule =
      (await this.gameConfig.getString(gameId, 'cold_storage_upload_schedule')) ?? DEFAULT_UPLOAD_SCHEDULE;
    const rawFileCompression = (await this.gameConfig.getString(gameId, 'raw_file_compression')) ?? DEFAULT_RAW_CODEC;

    return {
      // `cold_storage_enabled` IS in GAME_CONFIG_DEFAULTS (true) — use the shared reader.
      enabled: await this.gameConfig.getBoolean(gameId, 'cold_storage_enabled'),
      bucket,
      credentialsCipher,
      localRetentionDays: Math.max(0, Math.trunc(localRetentionDays)),
      rawRetentionDays: Math.max(0, Math.trunc(rawRetentionDays)),
      uploadSchedule,
      rawFileCompression,
    };
  }

  /** Read only the enable toggle (cheap gate for the job's cold-off no-op). */
  async isEnabled(gameId: string): Promise<boolean> {
    return this.gameConfig.getBoolean(gameId, 'cold_storage_enabled');
  }
}
