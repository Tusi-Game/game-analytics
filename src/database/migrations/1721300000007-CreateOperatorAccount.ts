import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * OPERATOR_ACCOUNT (T-10.1). Studio staff accounts — cross-game access, NO
 * game_id. `operator_id` uuid PK (default gen), unique email, argon2 password
 * hash, envelope-encrypted (nullable) TOTP secret, brute-force lockout columns,
 * text `role` (admin|viewer — NOT a PG enum). synchronize:false; snake_case auto.
 */
export class CreateOperatorAccount1721300000007 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'operator_account',
        columns: [
          { name: 'operator_id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'email', type: 'text', isUnique: true },
          { name: 'password_hash', type: 'text' },
          { name: 'mfa_totp_secret', type: 'text', isNullable: true },
          { name: 'failed_login_count', type: 'int', default: 0 },
          { name: 'locked_until', type: 'timestamptz', isNullable: true },
          { name: 'role', type: 'text', default: "'admin'" },
          { name: 'created_at', type: 'timestamptz' },
          { name: 'disabled_at', type: 'timestamptz', isNullable: true },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('operator_account', true);
  }
}
