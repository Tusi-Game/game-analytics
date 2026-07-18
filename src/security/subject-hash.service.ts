/**
 * Per-game KEYED subject hash (T-00.84, ops-envelope §7.5) — the `subject_ref`
 * scheme for `ERASURE_LEDGER`.
 *
 * `subject_ref = HMAC-SHA256(key = per_game_key, msg = user_id)`, hex. NEVER the
 * plaintext user_id (Q7 / DARK-SPOT: no PII in Postgres). Two properties:
 *  - DETERMINISTIC: recomputable at raw-rebuild time to re-apply the ledger as a
 *    filter (ops-envelope §7.3) — an envelope's user_id hashes to the same ref;
 *  - KEYED + per-game: the ledger cannot be brute-forced back to a user_id
 *    without the key, so it never becomes "a spine of erased people" (Art. 11).
 *
 * KEY BOUNDARY (what makes it lawful pseudonymization): the per-game key is
 * derived from the out-of-Postgres master key (SecretCryptoService) + the
 * game_id via HKDF-like SHA-256. A DB dump yields only hashes — the key material
 * lives outside the DB (env/secret mount), so the dump is not re-identifiable.
 * Same game_id + same master key ⇒ same per-game key ⇒ deterministic filtering.
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'node:crypto';

@Injectable()
export class SubjectHashService {
  /** Master key material (from env / secret mount). Empty ⇒ dev fallback. */
  private readonly master: string;

  constructor(config: ConfigService) {
    this.master = config.get<string>('SECRET_MASTER_KEY') ?? '';
  }

  /**
   * The per-game HMAC key = SHA-256(master || ':subject:' || game_id). Derived,
   * never stored — so the ledger stays keyless in Postgres. In dev (no master
   * key) a fixed-but-clearly-dev salt keeps the scheme working for tests; a
   * production deploy MUST set SECRET_MASTER_KEY (asserted by boot health check).
   */
  private perGameKey(gameId: string): Buffer {
    const material = `${this.master === '' ? 'DEV-INSECURE-MASTER' : this.master}:subject:${gameId}`;
    return createHash('sha256').update(material, 'utf8').digest();
  }

  /**
   * Compute the keyed `subject_ref` (hex) for a user_id under a game. The SAME
   * (gameId, userId) always yields the SAME ref (deterministic, for rebuild
   * filtering); different games yield different refs (per-game keyed).
   */
  subjectRef(gameId: string, userId: string): string {
    return createHmac('sha256', this.perGameKey(gameId)).update(userId, 'utf8').digest('hex');
  }

  /** True iff a real (non-dev) master key is configured. */
  get keyed(): boolean {
    return this.master.trim() !== '';
  }
}
