import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

/**
 * GDPR_REQUEST_AUDIT (T-10.29/T-10.31) — the operator ATTESTATION trail for
 * erasure + DSAR-access triggers. `audit_id` uuid PK; `game_id` TEXT FK → game,
 * `operator_id` uuid FK → operator_account. `subject_ref` is a keyed hash (never
 * plaintext user_id). Records who attested, the attestation note, and outcome —
 * the over-trusted-surface guard (admin RBAC + audit).
 */
export class CreateGdprRequestAudit1721300000013 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'gdpr_request_audit',
        columns: [
          { name: 'audit_id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'game_id', type: 'text' },
          { name: 'operator_id', type: 'uuid' },
          { name: 'kind', type: 'text' },
          { name: 'subject_ref', type: 'text' },
          { name: 'attestation', type: 'text' },
          { name: 'outcome', type: 'text' },
          { name: 'requested_at', type: 'timestamptz' },
        ],
      }),
      true,
    );
    await queryRunner.createForeignKey(
      'gdpr_request_audit',
      new TableForeignKey({
        columnNames: ['game_id'],
        referencedTableName: 'game',
        referencedColumnNames: ['game_id'],
        onDelete: 'CASCADE',
      }),
    );
    await queryRunner.createForeignKey(
      'gdpr_request_audit',
      new TableForeignKey({
        columnNames: ['operator_id'],
        referencedTableName: 'operator_account',
        referencedColumnNames: ['operator_id'],
        onDelete: 'RESTRICT',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('gdpr_request_audit', true);
  }
}
