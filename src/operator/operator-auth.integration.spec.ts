import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { connectPostgresOrNull, connectRedisOrNull } from '../testing/live-infra';
import { OperatorAuthService } from './operator-auth.service';
import { OperatorSessionService } from './operator-session.service';
import { PasswordService } from './password.service';
import { MfaService } from './mfa.service';
import { SecretCryptoService } from '../security/secret-crypto.service';
import { OperatorAccountEntity } from '../database/entities/operator-account.entity';
import { OperatorLoginAuditEntity } from '../database/entities/operator-login-audit.entity';
import type { Redis } from 'ioredis';

/**
 * Operator auth against LIVE Postgres + Redis (T-10.37/T-10.38/T-10.47):
 *   - lockout after N failed logins → refused until backoff, reset on success;
 *   - MFA required → a valid TOTP is needed; the stored secret is CIPHERTEXT;
 *   - failed logins land in the DISTINCT operator_login_audit stream.
 * Skips when the stack is unreachable.
 */

const MASTER = 'auth-int-master';

function cfg(overrides: Record<string, unknown>): ConfigService {
  return { get: (k: string) => overrides[k] } as unknown as ConfigService;
}

describe('Operator auth (live Postgres + Redis)', () => {
  let ds: DataSource | null = null;
  let redis: Redis | null = null;
  const EMAIL = `op-${Math.random().toString(36).slice(2)}@studio.test`;
  const PASSWORD = 'correct horse battery staple';

  const passwords = new PasswordService();
  const crypto = new SecretCryptoService(cfg({ SECRET_MASTER_KEY: MASTER }), MASTER);
  const mfa = new MfaService(crypto);

  beforeAll(async () => {
    ds = await connectPostgresOrNull();
    redis = await connectRedisOrNull();
  });

  afterAll(async () => {
    if (ds) {
      await ds.getRepository(OperatorLoginAuditEntity).delete({ emailAttempted: EMAIL });
      await ds.getRepository(OperatorAccountEntity).delete({ email: EMAIL });
      await ds.destroy();
    }
    if (redis) {
      redis.disconnect();
    }
  });

  function makeAuth(mfaRequired: boolean): OperatorAuthService {
    if (!ds || !redis) {
      throw new Error('unreachable');
    }
    const sessions = new OperatorSessionService(cfg({ OPERATOR_SESSION_TIMEOUT_MIN: 120 }), redis);
    return new OperatorAuthService(
      ds,
      cfg({ OPERATOR_LOGIN_MAX_ATTEMPTS: 3, OPERATOR_LOCKOUT_MIN: 15, OPERATOR_MFA_REQUIRED: mfaRequired }),
      passwords,
      mfa,
      sessions,
    );
  }

  it('lockout after max attempts, then reset on a later valid login', async () => {
    if (!ds || !redis) return;
    await ds.getRepository(OperatorAccountEntity).insert({
      email: EMAIL,
      passwordHash: await passwords.hash(PASSWORD),
      mfaTotpSecret: null,
      role: 'admin',
      createdAt: new Date(),
    });

    const auth = makeAuth(false);

    // 3 wrong-password attempts (max = 3) → the 3rd trips the lockout.
    for (let i = 0; i < 3; i += 1) {
      await expect(auth.login({ email: EMAIL, password: 'wrong' })).rejects.toThrow();
    }
    let acct = await ds.getRepository(OperatorAccountEntity).findOneOrFail({ where: { email: EMAIL } });
    expect(acct.failedLoginCount).toBeGreaterThanOrEqual(3);
    expect(acct.lockedUntil).not.toBeNull();
    expect((acct.lockedUntil as Date).getTime()).toBeGreaterThan(Date.now());

    // Even a CORRECT password is refused while locked.
    await expect(auth.login({ email: EMAIL, password: PASSWORD })).rejects.toThrow(/locked/i);

    // Clear the lockout window (simulate backoff elapsing) and log in → reset.
    await ds
      .getRepository(OperatorAccountEntity)
      .update({ email: EMAIL }, { lockedUntil: new Date(Date.now() - 1000) });
    const ok = await auth.login({ email: EMAIL, password: PASSWORD });
    expect(ok.session.email).toBe(EMAIL);
    acct = await ds.getRepository(OperatorAccountEntity).findOneOrFail({ where: { email: EMAIL } });
    expect(acct.failedLoginCount).toBe(0);
    expect(acct.lockedUntil).toBeNull();
  });

  it('MFA required → valid TOTP needed; secret stored as ciphertext; wrong code fails', async () => {
    if (!ds || !redis) return;
    // Enrol MFA and store the ENCRYPTED secret.
    const enrolment = mfa.enrol(EMAIL);
    await ds
      .getRepository(OperatorAccountEntity)
      .update({ email: EMAIL }, { mfaTotpSecret: enrolment.encryptedSecret });

    // The persisted secret is ciphertext, never the raw seed.
    const stored = await ds.getRepository(OperatorAccountEntity).findOneOrFail({ where: { email: EMAIL } });
    expect(stored.mfaTotpSecret).not.toBe(enrolment.secret);
    expect(stored.mfaTotpSecret?.startsWith('v1.')).toBe(true);

    const auth = makeAuth(true);
    // Password-only login is refused when MFA is in force.
    await expect(auth.login({ email: EMAIL, password: PASSWORD })).rejects.toThrow(/mfa/i);
    // Wrong code refused.
    await expect(auth.login({ email: EMAIL, password: PASSWORD, totpCode: '000000' })).rejects.toThrow(/mfa/i);
    // Valid code succeeds.
    const code = mfa.currentCode(enrolment.secret);
    const ok = await auth.login({ email: EMAIL, password: PASSWORD, totpCode: code });
    expect(ok.session.email).toBe(EMAIL);
  });

  it('failed logins land in the distinct operator_login_audit stream', async () => {
    if (!ds || !redis) return;
    const rows = await ds.getRepository(OperatorLoginAuditEntity).find({ where: { emailAttempted: EMAIL } });
    const outcomes = new Set(rows.map((r) => r.outcome));
    expect(rows.length).toBeGreaterThan(0);
    expect(outcomes.has('failed')).toBe(true); // at least one failed attempt recorded
    expect(outcomes.has('success')).toBe(true); // and at least one success
  });
});
