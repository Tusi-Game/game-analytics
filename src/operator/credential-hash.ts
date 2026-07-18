/**
 * Credential hashing (011) — the ONE canonical scheme for `sdk_key` /
 * `server_credential` at-rest hashing + lookup, shared by the migration, the
 * seed, the resolver rewrite, and the credential-lifecycle service so every
 * producer computes a byte-identical `key_hash` / `credential_hash`.
 *
 * WHY a fast KEYED hash (HMAC-SHA256), not argon2/bcrypt: these credentials are
 * HIGH-ENTROPY random tokens (32 bytes), not human passwords — there is nothing
 * to brute-force, so a slow KDF buys no security but would make the per-request
 * ingest auth lookup expensive. HMAC keyed by the out-of-Postgres master key
 * means a pure DB-dump of the hash column is not reversible/verifiable without
 * the master key (P13: master key outside Postgres). Determinism lets the
 * resolver look a credential up by hash (unique-indexed) in O(1).
 *
 * Key derivation mirrors SubjectHashService: SHA-256(master || ':credential:').
 * In dev/tests with no master key a fixed clearly-dev salt keeps the scheme
 * working (matches SubjectHashService's DEV-INSECURE fallback); production sets
 * SECRET_MASTER_KEY (asserted by the boot health check).
 *
 * Prefix convention (T-10.18, Stripe-style, secret-scanner friendly):
 *   - `pk_` — public client sdk_key   (provenance=client)
 *   - `sk_` — secret server credential (provenance=server)
 * The stored `*_prefix` column is the LEADING VISIBLE slice of the raw token
 * (class marker + a few chars), safe to display; the resolver never keys on it.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';

/** Class markers embedded at the front of every raw credential (T-10.18). */
export const SDK_KEY_PREFIX = 'pk_';
export const SERVER_CREDENTIAL_PREFIX = 'sk_';

/** How many leading chars of the raw token to persist as the public prefix. */
const VISIBLE_PREFIX_LEN = 11;

/** Random-token entropy (bytes) for a freshly issued credential. */
const TOKEN_ENTROPY_BYTES = 24;

/** The dev fallback salt when no master key is set (mirrors SubjectHashService). */
const DEV_MASTER = 'DEV-INSECURE-MASTER';

/** Derive the per-scheme HMAC key from the (out-of-DB) master key material. */
function credentialKey(master: string): Buffer {
  const material = `${master.trim() === '' ? DEV_MASTER : master}:credential:`;
  return createHash('sha256').update(material, 'utf8').digest();
}

/**
 * The canonical at-rest hash of a raw credential (hex). Deterministic for a
 * given (master, raw) — the resolver looks up by exactly this value.
 */
export function hashCredential(master: string, raw: string): string {
  return createHmac('sha256', credentialKey(master)).update(raw, 'utf8').digest('hex');
}

/** The public prefix (class marker + a few chars) persisted alongside the hash. */
export function credentialPrefix(raw: string): string {
  return raw.slice(0, VISIBLE_PREFIX_LEN);
}

/** Generate a fresh public `pk_…` sdk_key (raw, shown once at issue). */
export function generateSdkKey(): string {
  return `${SDK_KEY_PREFIX}${randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url')}`;
}

/** Generate a fresh secret `sk_…` server credential (raw, shown once at issue). */
export function generateServerCredential(): string {
  return `${SERVER_CREDENTIAL_PREFIX}${randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url')}`;
}
