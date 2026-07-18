import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * OPERATOR_LOGIN_AUDIT (T-10.5) — the failed-/successful-login audit stream,
 * DISTINCT from CONFIG_AUDIT. `audit_id` uuid PK, nullable `operator_id`
 * (unknown-email attempts have none), `email_attempted`, `timestamp`, `source`,
 * text `outcome`. Append-only. synchronize:false; snake_case auto.
 */
export class CreateOperatorLoginAudit1721300000008 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'operator_login_audit',
        columns: [
          { name: 'audit_id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'operator_id', type: 'uuid', isNullable: true },
          { name: 'email_attempted', type: 'text' },
          { name: 'timestamp', type: 'timestamptz' },
          { name: 'source', type: 'text', isNullable: true },
          { name: 'outcome', type: 'text' },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('operator_login_audit', true);
  }
}
