/**
 * Operator authentication (T-10.7-11) — login/logout, brute-force lockout,
 * optional TOTP MFA, and the failed-login audit stream.
 *
 * Login flow:
 *   1. look up the account by email; unknown email → audit `failed`, generic fail;
 *   2. if `disabled_at` set → refuse;
 *   3. if `locked_until` in the future → audit `locked`, refuse;
 *   4. verify the argon2 password; wrong → `failed_login_count++`, at
 *      `operator_login_max_attempts` set `locked_until = now + operator_lockout_min`,
 *      audit `failed`, refuse;
 *   5. if MFA required (globally OR the account enrolled) → verify the TOTP code
 *      against the envelope-decrypted secret; wrong/missing → audit `mfa_failed`,
 *      refuse (does NOT increment the password lockout counter);
 *   6. success → reset `failed_login_count`/`locked_until`, audit `success`,
 *      create a Redis session, return its id + the session record.
 *
 * Errors are intentionally generic (`UnauthorizedException`) so the surface does
 * not leak which factor failed to an attacker; the distinct outcome is recorded
 * only in the audit stream.
 */

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { OperatorAccountEntity } from '../database/entities/operator-account.entity';
import { OperatorLoginAuditEntity, type LoginOutcome } from '../database/entities/operator-login-audit.entity';
import { PasswordService } from './password.service';
import { MfaService } from './mfa.service';
import { OperatorSessionService, type OperatorSession } from './operator-session.service';

export interface LoginRequest {
  email: string;
  password: string;
  /** TOTP code, required when MFA is in force for the account. */
  totpCode?: string;
  /** Best-effort request source (remote IP) for the audit stream. */
  source?: string;
}

export interface LoginResult {
  sessionId: string;
  session: OperatorSession;
}

@Injectable()
export class OperatorAuthService {
  private readonly maxAttempts: number;
  private readonly lockoutMin: number;
  private readonly mfaGloballyRequired: boolean;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
    private readonly passwords: PasswordService,
    private readonly mfa: MfaService,
    private readonly sessions: OperatorSessionService,
  ) {
    this.maxAttempts = config.get<number>('OPERATOR_LOGIN_MAX_ATTEMPTS') ?? 5;
    this.lockoutMin = config.get<number>('OPERATOR_LOCKOUT_MIN') ?? 15;
    this.mfaGloballyRequired = config.get<boolean>('OPERATOR_MFA_REQUIRED') ?? false;
  }

  async login(req: LoginRequest): Promise<LoginResult> {
    const repo = this.dataSource.getRepository(OperatorAccountEntity);
    const account = await repo.findOne({ where: { email: req.email } });

    if (!account) {
      await this.audit(null, req.email, req.source, 'failed');
      throw new UnauthorizedException('Invalid credentials');
    }
    if (account.disabledAt !== null) {
      await this.audit(account.operatorId, req.email, req.source, 'failed');
      throw new UnauthorizedException('Invalid credentials');
    }
    if (account.lockedUntil !== null && account.lockedUntil.getTime() > Date.now()) {
      await this.audit(account.operatorId, req.email, req.source, 'locked');
      throw new UnauthorizedException('Account temporarily locked');
    }

    const passwordOk = await this.passwords.verify(account.passwordHash, req.password);
    if (!passwordOk) {
      await this.registerFailure(account);
      await this.audit(account.operatorId, req.email, req.source, 'failed');
      throw new UnauthorizedException('Invalid credentials');
    }

    // MFA: required globally OR the account has enrolled a secret.
    const mfaInForce = this.mfaGloballyRequired || account.mfaTotpSecret !== null;
    if (mfaInForce) {
      const code = req.totpCode ?? '';
      const okMfa = account.mfaTotpSecret !== null && this.mfa.verify(code, account.mfaTotpSecret);
      if (!okMfa) {
        await this.audit(account.operatorId, req.email, req.source, 'mfa_failed');
        throw new UnauthorizedException('MFA verification failed');
      }
    }

    // Success — reset the lockout counters.
    if (account.failedLoginCount !== 0 || account.lockedUntil !== null) {
      await repo.update({ operatorId: account.operatorId }, { failedLoginCount: 0, lockedUntil: null });
    }
    await this.audit(account.operatorId, req.email, req.source, 'success');

    const session: OperatorSession = {
      operatorId: account.operatorId,
      email: account.email,
      role: account.role,
    };
    const sessionId = await this.sessions.create(session);
    return { sessionId, session };
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.destroy(sessionId);
  }

  /** Increment the failure counter and lock out at the configured threshold. */
  private async registerFailure(account: OperatorAccountEntity): Promise<void> {
    const repo = this.dataSource.getRepository(OperatorAccountEntity);
    const next = account.failedLoginCount + 1;
    const patch: Partial<OperatorAccountEntity> = { failedLoginCount: next };
    if (next >= this.maxAttempts) {
      patch.lockedUntil = new Date(Date.now() + this.lockoutMin * 60_000);
    }
    await repo.update({ operatorId: account.operatorId }, patch);
  }

  private async audit(
    operatorId: string | null,
    emailAttempted: string,
    source: string | undefined,
    outcome: LoginOutcome,
  ): Promise<void> {
    await this.dataSource.getRepository(OperatorLoginAuditEntity).insert({
      operatorId,
      emailAttempted,
      source: source ?? null,
      outcome,
      timestamp: new Date(),
    });
  }
}
