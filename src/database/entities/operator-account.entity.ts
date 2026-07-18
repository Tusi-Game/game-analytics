import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * OPERATOR_ACCOUNT — the studio's staff accounts (011 design §ER, T-10.1).
 *
 * NOT game-scoped: one operator has cross-game ACCESS (a session grants read of
 * every game's results + write of every game's config/credentials), so there is
 * NO `game_id` here (per-game scoping is enforced at the write/view layer, P12).
 * Cardinality is tiny (studio staff, not players) — a `uuid` PK is fine and is
 * shown/referenced, so it is not bigint.
 *
 * Hardening (design §Account security): brute-force lockout via
 * `failedLoginCount` + `lockedUntil`; optional TOTP MFA whose secret is
 * ENVELOPE-ENCRYPTED (SecretCryptoService) at rest — a DB dump yields ciphertext,
 * never a usable TOTP seed. `role` is a plain text column (admin|viewer),
 * NEVER a Postgres enum (grows without a migration; enforced in the app layer).
 *
 * snake_case columns are produced by SnakeNamingStrategy — properties are
 * camelCase with NO hand-written `name:` overrides.
 */
export type OperatorRole = 'admin' | 'viewer';

@Entity('operator_account')
export class OperatorAccountEntity {
  /** Local id — uuid, default-generated (referenced/shown, not bigint). */
  @PrimaryGeneratedColumn('uuid')
  operatorId!: string;

  /** Login identity. UNIQUE so an email maps to exactly one account. */
  @Column({ type: 'text', unique: true })
  email!: string;

  /** Argon2id password hash (never the plaintext). See OperatorAuthService. */
  @Column({ type: 'text' })
  passwordHash!: string;

  /**
   * TOTP secret, ENVELOPE-ENCRYPTED (SecretCryptoService `v1.<iv>.<tag>.<ct>`
   * ciphertext) — null until the operator enrols in MFA. Decrypted in-memory
   * only to verify a code; the plaintext seed never touches Postgres.
   */
  @Column({ type: 'text', nullable: true })
  mfaTotpSecret!: string | null;

  /** Consecutive failed logins since the last success (brute-force lockout). */
  @Column({ type: 'int', default: 0 })
  failedLoginCount!: number;

  /** When set and in the future, auth is refused until it passes (lockout). */
  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  /** Role — `admin` (read+write) or `viewer` (read-only). Enforced in-app. */
  @Column({ type: 'text', default: 'admin' })
  role!: OperatorRole;

  @Column({ type: 'timestamptz' })
  createdAt!: Date;

  /** When set, the account is disabled and cannot log in. */
  @Column({ type: 'timestamptz', nullable: true })
  disabledAt!: Date | null;
}
