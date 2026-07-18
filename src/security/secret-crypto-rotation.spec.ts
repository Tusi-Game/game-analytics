import { SecretCryptoService } from './secret-crypto.service';

/**
 * Master-key rotation crypto primitive (T-10.22) — the dual-key decrypt-old /
 * encrypt-new building block. Proves the self-describing v1. ciphertext can be
 * moved from an OLD key to a NEW key, and that the old key can no longer read it.
 */
describe('SecretCryptoService dual-key rotation primitive', () => {
  const OLD = 'old-master-key-material';
  const NEW = 'new-master-key-material';

  it('encrypts under old, re-encrypts under new, old key can no longer decrypt', () => {
    const oldCrypto = SecretCryptoService.withRawKey(OLD);
    const newCrypto = SecretCryptoService.withRawKey(NEW);

    const plaintext = 'JADX7-TOTP-SEED-OR-S3-KEY';
    const underOld = oldCrypto.encrypt(plaintext);

    // Old key reads it; new key cannot (yet).
    expect(oldCrypto.decrypt(underOld)).toBe(plaintext);
    expect(() => newCrypto.decrypt(underOld)).toThrow();

    // Rotate: decrypt-old → encrypt-new.
    const underNew = newCrypto.encrypt(oldCrypto.decrypt(underOld));

    // New key reads it; OLD key can no longer decrypt the re-encrypted value.
    expect(newCrypto.decrypt(underNew)).toBe(plaintext);
    expect(() => oldCrypto.decrypt(underNew)).toThrow();

    // The ciphertext actually changed (different key/IV).
    expect(underNew).not.toBe(underOld);
  });

  it('withRawKey("") yields a disabled crypto (encrypt throws)', () => {
    const disabled = SecretCryptoService.withRawKey('');
    expect(disabled.enabled).toBe(false);
    expect(() => disabled.encrypt('x')).toThrow();
  });
});
