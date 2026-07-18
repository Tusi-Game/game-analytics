import { MigrationInterface, QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { credentialPrefix, hashCredential } from '../../operator/credential-hash';

/**
 * BLOCKER #1 + #2 resolution (011 research brief) — migrate GAME's inline
 * scalar credentials into the 1..N child tables and DEPRECATE the scalars.
 *
 * 002 shipped `game.sdk_key` (UNIQUE, PLAINTEXT) + `game.server_credential`
 * (nullable, plaintext). The design/foundation/ER-full require child tables with
 * HASHED, show-once storage. This migration, run AFTER the child tables exist
 * (007–011):
 *   1. for every existing GAME row, insert a `game_sdk_key` row holding the
 *      HASHED sdk_key (+ public prefix) so the rewritten resolver can still
 *      resolve the seed/e2e keys via the child-table path;
 *   2. for every GAME with a non-null `server_credential`, insert a hashed
 *      `game_server_credential` row (BLOCKER #2 — no plaintext preserved);
 *   3. DEPRECATE the inline columns: drop the UNIQUE constraint and make
 *      `sdk_key` NULLABLE (nullable-deprecate, NOT drop — the physical column
 *      drop is a deliberate follow-up so a stale reader / rollback path cannot
 *      break; the columns are no longer read by anything after the resolver
 *      rewrite).
 *
 * Hashing uses the shared `hashCredential(master, raw)` scheme (HMAC keyed by
 * the out-of-DB master key) so the migration, seed, resolver and services agree
 * byte-for-byte. The master key is read from `process.env.SECRET_MASTER_KEY`
 * (the CLI runs outside Nest DI); empty ⇒ the same DEV fallback the runtime uses.
 */
export class MigrateGameInlineCredentials1721300000012 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const master = process.env.SECRET_MASTER_KEY ?? '';

    const games: Array<{ game_id: string; sdk_key: string | null; server_credential: string | null }> =
      await queryRunner.query('SELECT game_id, sdk_key, server_credential FROM game');

    const now = new Date().toISOString();
    for (const g of games) {
      if (typeof g.sdk_key === 'string' && g.sdk_key.length > 0) {
        // Idempotency: skip if a row for this exact hash already exists.
        const hash = hashCredential(master, g.sdk_key);
        const exists: Array<{ one: number }> = await queryRunner.query(
          'SELECT 1 AS one FROM game_sdk_key WHERE key_hash = $1',
          [hash],
        );
        if (exists.length === 0) {
          await queryRunner.query(
            `INSERT INTO game_sdk_key (game_id, key_id, key_prefix, key_hash, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [g.game_id, randomUUID(), credentialPrefix(g.sdk_key), hash, now],
          );
        }
      }
      if (typeof g.server_credential === 'string' && g.server_credential.length > 0) {
        const hash = hashCredential(master, g.server_credential);
        const exists: Array<{ one: number }> = await queryRunner.query(
          'SELECT 1 AS one FROM game_server_credential WHERE credential_hash = $1',
          [hash],
        );
        if (exists.length === 0) {
          await queryRunner.query(
            `INSERT INTO game_server_credential (game_id, credential_id, credential_prefix, credential_hash, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [g.game_id, randomUUID(), credentialPrefix(g.server_credential), hash, now],
          );
        }
      }
    }

    // Deprecate the inline scalars: drop the UNIQUE on sdk_key and make it
    // nullable. Keep the columns physically (nullable-deprecate) so a partial
    // rollback or a not-yet-updated reader degrades safely instead of erroring.
    await queryRunner.query('ALTER TABLE game DROP CONSTRAINT IF EXISTS "UQ_game_sdk_key"');
    // The unique constraint name TypeORM generated for `isUnique: true` is not
    // deterministic across versions; drop by discovering it too.
    const uniques: Array<{ conname: string }> = await queryRunner.query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'game'::regclass AND contype = 'u'`,
    );
    for (const u of uniques) {
      await queryRunner.query(`ALTER TABLE game DROP CONSTRAINT IF EXISTS "${u.conname}"`);
    }
    await queryRunner.query('ALTER TABLE game ALTER COLUMN sdk_key DROP NOT NULL');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort reversal: restore the scalar from the child rows so the pre-012
    // resolver path (should it ever run again) still works, then re-tighten.
    // NOTE the child hashes are one-way — we cannot restore the PLAINTEXT sdk_key.
    // The down path therefore restores NOT-NULL only if every game still has a
    // scalar; otherwise it leaves the column nullable (documented) to avoid a
    // failed migration on already-migrated data.
    const missing: Array<{ game_id: string }> = await queryRunner.query(
      'SELECT game_id FROM game WHERE sdk_key IS NULL',
    );
    if (missing.length === 0) {
      await queryRunner.query('ALTER TABLE game ALTER COLUMN sdk_key SET NOT NULL');
      await queryRunner.query('ALTER TABLE game ADD CONSTRAINT "UQ_game_sdk_key" UNIQUE (sdk_key)');
    }
    // The child rows inserted by up() are left in place — dropping them belongs to
    // the child-table migrations' own down() (009/010), which run after this.
  }
}
