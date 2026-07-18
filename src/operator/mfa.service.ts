/**
 * Operator TOTP MFA (T-10.9) — self-hosted RFC-6238, no external service.
 *
 * Choice: `otplib` (maintained, RFC-6238 TOTP). Enrolment generates a base32
 * secret; the secret is ENVELOPE-ENCRYPTED (SecretCryptoService) before it is
 * stored in `operator_account.mfa_totp_secret` — a DB dump yields ciphertext,
 * never a usable seed (P13, FR-029). Verification decrypts in-memory only.
 *
 * If no master key is configured (dev), enrolment cannot securely persist a
 * secret, so it throws (fail loud) rather than storing a plaintext seed — mirrors
 * SecretCryptoService.encrypt().
 */

import { Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import { SecretCryptoService } from '../security/secret-crypto.service';

/** The material an operator needs to enrol an authenticator app. */
export interface MfaEnrolment {
  /** The raw base32 secret (show once so the operator can add it manually). */
  secret: string;
  /** otpauth:// URI for a QR code. */
  otpauthUri: string;
  /** The envelope-encrypted secret to persist (never the raw). */
  encryptedSecret: string;
}

@Injectable()
export class MfaService {
  constructor(private readonly crypto: SecretCryptoService) {}

  /**
   * Generate a fresh TOTP secret + its encrypted form for an operator. The raw
   * secret + otpauth URI are returned ONCE for enrolment; only `encryptedSecret`
   * is persisted. Throws if no master key is configured (would store plaintext).
   */
  enrol(email: string, issuer = 'analytics-platform'): MfaEnrolment {
    const secret = authenticator.generateSecret();
    const encryptedSecret = this.crypto.encrypt(secret);
    const otpauthUri = authenticator.keyuri(email, issuer, secret);
    return { secret, otpauthUri, encryptedSecret };
  }

  /**
   * Verify a submitted TOTP code against the stored ENCRYPTED secret. Decrypts
   * in-memory only. False on any decrypt/parse/mismatch error.
   */
  verify(code: string, encryptedSecret: string): boolean {
    try {
      const secret = this.crypto.decrypt(encryptedSecret);
      return authenticator.check(code, secret);
    } catch {
      return false;
    }
  }

  /** Generate a current code for a raw secret (test helper / enrolment confirm). */
  currentCode(secret: string): string {
    return authenticator.generate(secret);
  }

  /**
   * Verify a submitted TOTP code against a RAW (not-yet-encrypted) secret. Used
   * during enrolment (012 OperatorAdminService.setMfa): the operator proves
   * possession of the freshly generated secret BEFORE its encrypted form is
   * persisted, so a mistyped secret never becomes a locked-out account.
   */
  verifyRaw(code: string, secret: string): boolean {
    try {
      return authenticator.check(code, secret);
    } catch {
      return false;
    }
  }
}
