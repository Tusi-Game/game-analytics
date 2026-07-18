/**
 * OperatorAdminService (T-11.79-81) — the operator ACCOUNT write-path the 012
 * panel drives for `operators/list` + `operators/form`. 011 shipped the account
 * ENTITY, {@link PasswordService}, {@link MfaService}, and the auth/session
 * services, but NO create/edit/disable account API — this service closes that gap
 * as sanctioned new write-path code (research brief §9 blocker 1).
 *
 * Invariants:
 *  - accounts are NEVER hard-deleted — `disable` sets `disabled_at` (spec §2.10,
 *    audit-trail integrity); `enable` clears it;
 *  - passwords are hashed with the existing {@link PasswordService} (argon2id) —
 *    the plaintext never lands in Postgres;
 *  - MFA persistence (blocker 2): `setMfa` writes the ENVELOPE-ENCRYPTED secret
 *    (from {@link MfaService.enrol}) back to the account after the operator has
 *    verified a code against the RAW secret; `resetMfa` clears it. The plaintext
 *    seed never touches Postgres;
 *  - admin-only at the controller via `@Roles('admin')`;
 *  - the operator PK (uuid) is never reassigned; email is UNIQUE (a duplicate is
 *    rejected as a 400).
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { OperatorAccountEntity, type OperatorRole } from '../database/entities/operator-account.entity';
import { PasswordService } from './password.service';
import { MfaService } from './mfa.service';

/** A viewable (non-secret) operator account row for the admin list. */
export interface OperatorView {
  operatorId: string;
  email: string;
  role: OperatorRole;
  mfaEnrolled: boolean;
  disabled: boolean;
  disabledAt: Date | null;
  createdAt: Date;
}

/** Create-account input. */
export interface CreateOperatorInput {
  email: string;
  password: string;
  role: OperatorRole;
}

/** Edit-account input — omitted fields are left unchanged (blank password keeps current). */
export interface EditOperatorInput {
  email?: string;
  role?: OperatorRole;
  /** When non-empty, replaces the password; blank/undefined keeps the current one. */
  password?: string;
}

@Injectable()
export class OperatorAdminService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly passwords: PasswordService,
    private readonly mfa: MfaService,
  ) {}

  /** List all operator accounts (admin surface), oldest first. */
  async list(): Promise<OperatorView[]> {
    const rows = await this.dataSource.getRepository(OperatorAccountEntity).find({ order: { createdAt: 'ASC' } });
    return rows.map((r) => this.toView(r));
  }

  /** Load one account, or 404. */
  async get(operatorId: string): Promise<OperatorView> {
    const row = await this.findOrThrow(operatorId);
    return this.toView(row);
  }

  /** Create an operator account (email UNIQUE; password argon2id-hashed). */
  async create(input: CreateOperatorInput): Promise<OperatorView> {
    const email = input.email.trim().toLowerCase();
    if (email === '') {
      throw new BadRequestException('email is required');
    }
    if (input.password.length === 0) {
      throw new BadRequestException('password is required');
    }
    const repo = this.dataSource.getRepository(OperatorAccountEntity);
    const existing = await repo.findOne({ where: { email } });
    if (existing) {
      throw new BadRequestException(`an operator with email "${email}" already exists`);
    }
    const passwordHash = await this.passwords.hash(input.password);
    const created = await repo.save(
      repo.create({
        email,
        passwordHash,
        role: input.role,
        mfaTotpSecret: null,
        failedLoginCount: 0,
        lockedUntil: null,
        createdAt: new Date(),
        disabledAt: null,
      }),
    );
    return this.toView(created);
  }

  /** Edit an operator account (blank password keeps current; email must stay unique). */
  async edit(operatorId: string, input: EditOperatorInput): Promise<OperatorView> {
    const repo = this.dataSource.getRepository(OperatorAccountEntity);
    const row = await this.findOrThrow(operatorId);

    const patch: Partial<OperatorAccountEntity> = {};
    if (input.email !== undefined) {
      const email = input.email.trim().toLowerCase();
      if (email === '') {
        throw new BadRequestException('email cannot be empty');
      }
      if (email !== row.email) {
        const clash = await repo.findOne({ where: { email } });
        if (clash && clash.operatorId !== operatorId) {
          throw new BadRequestException(`an operator with email "${email}" already exists`);
        }
        patch.email = email;
      }
    }
    if (input.role !== undefined) {
      patch.role = input.role;
    }
    if (input.password !== undefined && input.password.length > 0) {
      patch.passwordHash = await this.passwords.hash(input.password);
    }
    if (Object.keys(patch).length > 0) {
      await repo.update({ operatorId }, patch);
    }
    return this.get(operatorId);
  }

  /**
   * Disable an account (never delete): stamp `disabled_at`. Idempotent — a
   * disabled account stays disabled. The row is preserved for audit-trail
   * integrity (login audit + config audit reference the operator).
   */
  async disable(operatorId: string): Promise<OperatorView> {
    const row = await this.findOrThrow(operatorId);
    if (row.disabledAt === null) {
      await this.dataSource.getRepository(OperatorAccountEntity).update({ operatorId }, { disabledAt: new Date() });
    }
    return this.get(operatorId);
  }

  /** Re-enable a disabled account (clear `disabled_at`). Idempotent. */
  async enable(operatorId: string): Promise<OperatorView> {
    const row = await this.findOrThrow(operatorId);
    if (row.disabledAt !== null) {
      await this.dataSource.getRepository(OperatorAccountEntity).update({ operatorId }, { disabledAt: null });
    }
    return this.get(operatorId);
  }

  /**
   * Begin an MFA enrolment for an account: generate a fresh TOTP secret + otpauth
   * URI (shown ONCE so the operator can add it to an authenticator). Nothing is
   * persisted yet — {@link setMfa} persists the encrypted form after the operator
   * proves possession by verifying a code (blocker 2). Throws if no master key is
   * configured (would store a plaintext seed).
   */
  async beginMfaEnrolment(
    operatorId: string,
  ): Promise<{ secret: string; otpauthUri: string; encryptedSecret: string }> {
    const row = await this.findOrThrow(operatorId);
    return this.mfa.enrol(row.email);
  }

  /**
   * Persist a verified MFA enrolment: verify `code` against the RAW `secret`, then
   * write the `encryptedSecret` (from {@link beginMfaEnrolment}) back to the
   * account. Rejects when the code does not match — the plaintext seed is never
   * persisted and the account keeps its prior MFA state.
   */
  async setMfa(operatorId: string, secret: string, encryptedSecret: string, code: string): Promise<OperatorView> {
    await this.findOrThrow(operatorId);
    if (!this.mfa.verifyRaw(code, secret)) {
      throw new BadRequestException('the verification code did not match the new MFA secret');
    }
    await this.dataSource
      .getRepository(OperatorAccountEntity)
      .update({ operatorId }, { mfaTotpSecret: encryptedSecret });
    return this.get(operatorId);
  }

  /** Reset (remove) MFA on an account — clears the stored encrypted secret. */
  async resetMfa(operatorId: string): Promise<OperatorView> {
    await this.findOrThrow(operatorId);
    await this.dataSource.getRepository(OperatorAccountEntity).update({ operatorId }, { mfaTotpSecret: null });
    return this.get(operatorId);
  }

  private async findOrThrow(operatorId: string): Promise<OperatorAccountEntity> {
    const row = await this.dataSource.getRepository(OperatorAccountEntity).findOne({ where: { operatorId } });
    if (!row) {
      throw new NotFoundException(`operator "${operatorId}" not found`);
    }
    return row;
  }

  private toView(row: OperatorAccountEntity): OperatorView {
    return {
      operatorId: row.operatorId,
      email: row.email,
      role: row.role,
      mfaEnrolled: row.mfaTotpSecret !== null,
      disabled: row.disabledAt !== null,
      disabledAt: row.disabledAt,
      createdAt: row.createdAt,
    };
  }
}
