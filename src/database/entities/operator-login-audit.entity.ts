import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * OPERATOR_LOGIN_AUDIT — the failed-/successful-login audit stream (011 design
 * §Account security, T-10.5). DISTINCT from CONFIG_AUDIT: this is the security /
 * brute-force trail, not the config-change trail. Append-only.
 *
 * `operatorId` is nullable — a failed login for an unknown email has no account
 * to attribute, but `emailAttempted` is always recorded. `outcome` is a plain
 * text column (`success` | `failed` | `locked` | `mfa_failed`), grows without a
 * migration. Stand-alone (not game-scoped) — operators are cross-game staff.
 */
export type LoginOutcome = 'success' | 'failed' | 'locked' | 'mfa_failed';

@Entity('operator_login_audit')
export class OperatorLoginAuditEntity {
  /** Local audit id — uuid, default-generated. */
  @PrimaryGeneratedColumn('uuid')
  auditId!: string;

  /** Account attributed to the attempt, or null for an unknown email. */
  @Column({ type: 'uuid', nullable: true })
  operatorId!: string | null;

  /** The email the caller attempted to log in with (always recorded). */
  @Column({ type: 'text' })
  emailAttempted!: string;

  @Column({ type: 'timestamptz' })
  timestamp!: Date;

  /** Request source (e.g. remote IP), best-effort; null when unavailable. */
  @Column({ type: 'text', nullable: true })
  source!: string | null;

  /** Attempt outcome (success | failed | locked | mfa_failed). */
  @Column({ type: 'text' })
  outcome!: LoginOutcome;
}
