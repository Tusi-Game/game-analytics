/**
 * Operator password hashing (T-10.7/T-10.8) — argon2id.
 *
 * Choice: argon2id (memory-hard, the current OWASP-recommended default for
 * PASSWORD hashing) via the maintained `argon2` package. Operator passwords are
 * human-chosen and low-entropy, so a slow memory-hard KDF is exactly right here
 * (contrast credential-hash.ts, which uses a fast keyed HMAC because credentials
 * are high-entropy random tokens). Defaults are the library's argon2id preset.
 */

import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

@Injectable()
export class PasswordService {
  /** Hash a plaintext password (argon2id). Returns the self-describing PHC string. */
  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, { type: argon2.argon2id });
  }

  /** Verify a plaintext against a stored argon2 hash. False on any mismatch/error. */
  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      return false;
    }
  }
}
