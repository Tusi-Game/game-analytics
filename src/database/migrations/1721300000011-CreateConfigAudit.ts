import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

/**
 * CONFIG_AUDIT (T-10.4) — append-only forward-only config change trail.
 * Composite PK `(game_id, audit_id)`; `game_id` TEXT FK → game, `audit_id` uuid,
 * `operator_id` uuid FK → operator_account. `old_value` nullable text,
 * `new_value` text, `changed_at`, `effective_from` (processing-time watermark).
 */
export class CreateConfigAudit1721300000011 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'config_audit',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'audit_id', type: 'uuid', isPrimary: true },
          { name: 'operator_id', type: 'uuid' },
          { name: 'config_key', type: 'text' },
          { name: 'old_value', type: 'text', isNullable: true },
          { name: 'new_value', type: 'text' },
          { name: 'changed_at', type: 'timestamptz' },
          { name: 'effective_from', type: 'timestamptz' },
        ],
      }),
      true,
    );
    await queryRunner.createForeignKey(
      'config_audit',
      new TableForeignKey({
        columnNames: ['game_id'],
        referencedTableName: 'game',
        referencedColumnNames: ['game_id'],
        onDelete: 'CASCADE',
      }),
    );
    await queryRunner.createForeignKey(
      'config_audit',
      new TableForeignKey({
        columnNames: ['operator_id'],
        referencedTableName: 'operator_account',
        referencedColumnNames: ['operator_id'],
        onDelete: 'RESTRICT',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('config_audit', true);
  }
}
