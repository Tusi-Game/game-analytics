/**
 * Envelope-encryption for REVERSIBLE infra secrets (T-00.84, FR-029,
 * ops-envelope §9).
 *
 * `cold_storage_credentials`, `fx_table` material, and the per-game
 * `ERASURE_LEDGER` hash key must be reversible (workers need the plaintext), so
 * one-way hashing is impossible. Instead they are envelope-encrypted with a
 * MASTER KEY held OUTSIDE Postgres (env / Docker secret / file mount), decrypted
 * only in-worker. A pure DB-dump leak then yields CIPHERTEXT, not the operator's
 * object-store keys — and, critically, not the erasure-ledger hash key, which is
 * what makes the keyed `subject_ref` lawful pseudonymization (Art. 11): with the
 * key in the same DB, a dump would give both hashes and key → a re-identifiable
 * registry of erased people. Key-separation is therefore normative.
 *
 * Scheme: AES-256-GCM. The master key is derived from `SECRET_MASTER_KEY` via
 * SHA-256 (accepts any length input; yields a 32-byte key). Each ciphertext is
 * self-describing: `v1.<iv_b64>.<tag_b64>.<ct_b64>`, so rotation to a v2 scheme
 * is additive. A random 12-byte IV per encryption.
 *
 * Server credentials / sdk_key stay ONE-WAY hashed elsewhere — only
 * reversible-by-necessity secrets get this treatment.
 */

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** DI token for the raw master key material (test override / secret mount). */
export const SECRET_MASTER_KEY = 'SECRET_MASTER_KEY';

const SCHEME_PREFIX = 'v1';
const IV_BYTES = 12;
const ALGO = 'aes-256-gcm';

@Injectable()
export class SecretCryptoService {
  /** 32-byte derived key, or null when no master key is configured (dev). */
  private readonly key: Buffer | null;

  constructor(config: ConfigService, @Inject(SECRET_MASTER_KEY) rawOverride?: string) {
    const raw = rawOverride ?? config.get<string>('SECRET_MASTER_KEY') ?? '';
    this.key = raw.trim() === '' ? null : createHash('sha256').update(raw, 'utf8').digest();
  }

  /** True iff a master key is configured (envelope-encryption is active). */
  get enabled(): boolean {
    return this.key !== null;
  }

  /**
   * Encrypt a reversible secret. Returns the self-describing ciphertext string.
   * With NO master key configured (dev) it throws — callers that must persist a
   * secret should assert {@link enabled} at boot, so a production deploy without a
   * key fails loudly rather than storing plaintext.
   */
  encrypt(plaintext: string): string {
    if (!this.key) {
      throw new Error('[secret-crypto] SECRET_MASTER_KEY is not configured; cannot encrypt a reversible secret');
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [SCHEME_PREFIX, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
  }

  /**
   * Decrypt a ciphertext produced by {@link encrypt}. Throws on a tampered or
   * malformed token (GCM auth failure) or when no master key is configured.
   */
  decrypt(token: string): string {
    if (!this.key) {
      throw new Error('[secret-crypto] SECRET_MASTER_KEY is not configured; cannot decrypt');
    }
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== SCHEME_PREFIX) {
      throw new Error('[secret-crypto] malformed or unsupported ciphertext token');
    }
    const iv = Buffer.from(parts[1]!, 'base64');
    const tag = Buffer.from(parts[2]!, 'base64');
    const ct = Buffer.from(parts[3]!, 'base64');
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}
