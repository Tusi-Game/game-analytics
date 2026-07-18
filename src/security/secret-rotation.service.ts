/**
 * Master-key ROTATION path (T-10.22, FR-029, ops-envelope §9/§10) — a bulk
 * re-encrypt of every envelope-encrypted row under a NEW master key. NOT a
 * flag-day: SecretCryptoService's self-describing `v1.` prefix lets a re-encrypt
 * pass run online, row-by-row.
 *
 * Operational sequence (DUAL-KEY decrypt-old / encrypt-new window):
 *   1. Generate the new master key (kept OUTSIDE Postgres — env / Docker secret).
 *   2. Bring the fleet up with BOTH keys available (old = SECRET_MASTER_KEY,
 *      new = SECRET_MASTER_KEY_NEW). During this window a decrypt tries the new
 *      key first, then the old — so already-rotated AND not-yet-rotated rows both
 *      decrypt. (This service is the re-encrypt engine; the read fallback lives in
 *      the callers that decrypt — MfaService/config reader — during the window.)
 *   3. Run {@link reEncryptAll}: for each envelope-encrypted value, decrypt under
 *      the OLD key and re-encrypt under the NEW key. Idempotent — a value already
 *      re-encrypted (decrypts under NEW, fails under OLD) is left as-is, so a
 *      re-run or a crash-resume converges.
 *   4. When the pass reports every row migrated, RETIRE the old key: promote
 *      SECRET_MASTER_KEY = new, drop SECRET_MASTER_KEY_NEW, restart. A DB dump now
 *      yields only NEW-key ciphertext; the old key is gone.
 *
 * Covered rows:
 *   - OPERATOR_ACCOUNT.mfa_totp_secret (envelope-encrypted TOTP seeds);
 *   - GAME.config infra-secret knobs (cold_storage_credentials, fx_table) — the
 *     reversible secrets ConfigAdminService envelope-encrypts.
 *
 * Everything is best-effort per row: a single undecryptable value is logged and
 * skipped (counted in `skipped`), never aborting the whole pass.
 */

import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OperatorAccountEntity } from '../database/entities/operator-account.entity';
import { GameEntity } from '../database/entities/game.entity';
import { SecretCryptoService } from './secret-crypto.service';
import { INFRA_SECRET_KNOBS } from '../config/config-admin.service';

/** Outcome of a full re-encrypt pass. */
export interface ReEncryptResult {
  /** Values re-encrypted old→new this pass. */
  reEncrypted: number;
  /** Values already under the new key (or empty) — no action needed. */
  alreadyCurrent: number;
  /** Values that could not be decrypted under either key (logged; left as-is). */
  skipped: number;
}

@Injectable()
export class SecretRotationService {
  private readonly logger = new Logger(SecretRotationService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Re-encrypt every envelope-encrypted row from `oldRawKey` to `newRawKey`.
   * Idempotent + resumable. `oldRawKey`/`newRawKey` are the raw master-key
   * strings (the same material SECRET_MASTER_KEY holds), never persisted here.
   */
  async reEncryptAll(oldRawKey: string, newRawKey: string): Promise<ReEncryptResult> {
    if (oldRawKey.trim() === '' || newRawKey.trim() === '') {
      throw new Error('[secret-rotation] both old and new master keys are required');
    }
    if (oldRawKey === newRawKey) {
      throw new Error('[secret-rotation] new master key must differ from the old key');
    }
    const oldCrypto = SecretCryptoService.withRawKey(oldRawKey);
    const newCrypto = SecretCryptoService.withRawKey(newRawKey);

    const total: ReEncryptResult = { reEncrypted: 0, alreadyCurrent: 0, skipped: 0 };
    this.accumulate(total, await this.reEncryptMfaSecrets(oldCrypto, newCrypto));
    this.accumulate(total, await this.reEncryptInfraConfig(oldCrypto, newCrypto));
    this.logger.log(
      `[secret-rotation] pass complete: reEncrypted=${total.reEncrypted} alreadyCurrent=${total.alreadyCurrent} skipped=${total.skipped}`,
    );
    return total;
  }

  // ── OPERATOR_ACCOUNT.mfa_totp_secret ─────────────────────────────────────

  private async reEncryptMfaSecrets(
    oldCrypto: SecretCryptoService,
    newCrypto: SecretCryptoService,
  ): Promise<ReEncryptResult> {
    const repo = this.dataSource.getRepository(OperatorAccountEntity);
    const rows = await repo.find({ select: { operatorId: true, mfaTotpSecret: true } });
    const result: ReEncryptResult = { reEncrypted: 0, alreadyCurrent: 0, skipped: 0 };

    for (const row of rows) {
      const cipher = row.mfaTotpSecret;
      if (cipher === null || cipher === '') {
        continue; // no MFA enrolled — nothing to rotate.
      }
      const next = this.rotateCiphertext(
        cipher,
        oldCrypto,
        newCrypto,
        result,
        `operator ${row.operatorId} mfa_totp_secret`,
      );
      if (next !== null) {
        await repo.update({ operatorId: row.operatorId }, { mfaTotpSecret: next });
      }
    }
    return result;
  }

  // ── GAME.config infra-secret knobs ───────────────────────────────────────

  private async reEncryptInfraConfig(
    oldCrypto: SecretCryptoService,
    newCrypto: SecretCryptoService,
  ): Promise<ReEncryptResult> {
    const repo = this.dataSource.getRepository(GameEntity);
    const games = await repo.find({ select: { gameId: true, config: true } });
    const result: ReEncryptResult = { reEncrypted: 0, alreadyCurrent: 0, skipped: 0 };

    for (const game of games) {
      const config = game.config ?? {};
      let dirty = false;
      const patch: Record<string, unknown> = {};
      for (const key of INFRA_SECRET_KNOBS) {
        const value = config[key];
        if (typeof value !== 'string' || value === '') {
          continue;
        }
        const next = this.rotateCiphertext(value, oldCrypto, newCrypto, result, `game ${game.gameId} ${key}`);
        if (next !== null) {
          patch[key] = next;
          dirty = true;
        }
      }
      if (dirty) {
        await repo
          .createQueryBuilder()
          .update(GameEntity)
          .set({ config: () => `config || :patch::jsonb` })
          .where('game_id = :gameId', { gameId: game.gameId })
          .setParameter('patch', JSON.stringify(patch))
          .execute();
      }
    }
    return result;
  }

  /**
   * Rotate one ciphertext old→new. Returns the new ciphertext to persist, or null
   * when no write is needed (already under the new key, or undecryptable/skipped).
   * Updates `result` counters. Idempotent: if the value decrypts under NEW it is
   * already current; if it decrypts under OLD it is re-encrypted; otherwise it is
   * skipped (logged).
   */
  private rotateCiphertext(
    cipher: string,
    oldCrypto: SecretCryptoService,
    newCrypto: SecretCryptoService,
    result: ReEncryptResult,
    label: string,
  ): string | null {
    // Already under the new key? (resume-safe) — leave as-is.
    try {
      newCrypto.decrypt(cipher);
      result.alreadyCurrent += 1;
      return null;
    } catch {
      // fall through: not yet under the new key.
    }
    // Decrypt under the OLD key and re-encrypt under the NEW key.
    try {
      const plaintext = oldCrypto.decrypt(cipher);
      const next = newCrypto.encrypt(plaintext);
      result.reEncrypted += 1;
      return next;
    } catch {
      this.logger.warn(`[secret-rotation] could not decrypt ${label} under the old key — skipped`);
      result.skipped += 1;
      return null;
    }
  }

  private accumulate(into: ReEncryptResult, add: ReEncryptResult): void {
    into.reEncrypted += add.reEncrypted;
    into.alreadyCurrent += add.alreadyCurrent;
    into.skipped += add.skipped;
  }
}
