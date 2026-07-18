import {
  SDK_KEY_PREFIX,
  SERVER_CREDENTIAL_PREFIX,
  credentialPrefix,
  generateSdkKey,
  generateServerCredential,
  hashCredential,
} from './credential-hash';

/**
 * Credential hashing scheme (011) — the shared, deterministic, keyed-hash used by
 * the migration/seed/resolver/service. Proves: determinism, keying (a different
 * master ⇒ a different hash), prefix-class markers survive, and generated tokens
 * carry the right class prefix (T-10.18, P5 credential-class trust).
 */
describe('credential-hash', () => {
  it('is deterministic for the same (master, raw)', () => {
    expect(hashCredential('m', 'pk_abc')).toBe(hashCredential('m', 'pk_abc'));
  });

  it('is KEYED — a different master yields a different hash', () => {
    expect(hashCredential('m1', 'pk_abc')).not.toBe(hashCredential('m2', 'pk_abc'));
  });

  it('a different raw yields a different hash', () => {
    expect(hashCredential('m', 'pk_a')).not.toBe(hashCredential('m', 'pk_b'));
  });

  it('generated sdk_key carries the pk_ class prefix; server credential carries sk_', () => {
    expect(generateSdkKey().startsWith(SDK_KEY_PREFIX)).toBe(true);
    expect(generateServerCredential().startsWith(SERVER_CREDENTIAL_PREFIX)).toBe(true);
  });

  it('the persisted prefix is the leading visible slice (class recognizable on sight)', () => {
    const raw = generateSdkKey();
    expect(raw.startsWith(credentialPrefix(raw))).toBe(true);
    expect(credentialPrefix(raw).startsWith(SDK_KEY_PREFIX)).toBe(true);
  });

  it('generated tokens are unique across calls', () => {
    expect(generateSdkKey()).not.toBe(generateSdkKey());
  });
});
