import { ConfigService } from '@nestjs/config';
import { MfaService } from './mfa.service';
import { SecretCryptoService } from '../security/secret-crypto.service';

/**
 * Operator TOTP MFA (T-10.9/T-10.38). Proves: enrolment envelope-ENCRYPTS the
 * secret (the stored form is NOT the plaintext seed → a DB dump yields
 * ciphertext); a current code verifies against the encrypted secret; a wrong code
 * fails; and with no master key, enrolment throws rather than storing plaintext.
 */

function crypto(masterKey: string): SecretCryptoService {
  const cfg = { get: () => masterKey } as unknown as ConfigService;
  return new SecretCryptoService(cfg, masterKey);
}

describe('MfaService (self-hosted TOTP)', () => {
  it('enrolment encrypts the secret; a current code verifies against the ciphertext', () => {
    const mfa = new MfaService(crypto('master-key'));
    const { secret, encryptedSecret } = mfa.enrol('op@studio.test');

    // The stored form is ciphertext, NOT the raw seed (secret-never-plaintext).
    expect(encryptedSecret).not.toBe(secret);
    expect(encryptedSecret.startsWith('v1.')).toBe(true);

    const code = mfa.currentCode(secret);
    expect(mfa.verify(code, encryptedSecret)).toBe(true);
  });

  it('rejects a wrong code', () => {
    const mfa = new MfaService(crypto('master-key'));
    const { encryptedSecret } = mfa.enrol('op@studio.test');
    expect(mfa.verify('000000', encryptedSecret)).toBe(false);
  });

  it('verify returns false (never throws) on a malformed ciphertext', () => {
    const mfa = new MfaService(crypto('master-key'));
    expect(mfa.verify('123456', 'not-ciphertext')).toBe(false);
  });

  it('enrolment throws with no master key (fails loud rather than storing plaintext)', () => {
    const mfa = new MfaService(crypto(''));
    expect(() => mfa.enrol('op@studio.test')).toThrow();
  });
});
