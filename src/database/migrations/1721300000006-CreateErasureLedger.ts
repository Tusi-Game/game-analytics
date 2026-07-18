import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * ERASURE_LEDGER table (T-01/T-00.17). Composite PK (game_id, request_id).
 * subject_ref is a per-game keyed HASH of user_id — never plaintext (Q7).
 * status is plain text (pending|awaiting_seal|executed).
 */
export class CreateErasureLedger1721300000006 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'erasure_ledger',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'request_id', type: 'text', isPrimary: true },
          { name: 'requested_at', type: 'timestamptz' },
          { name: 'status', type: 'text', default: "'pending'" },
          { name: 'executed_at', type: 'timestamptz', isNullable: true },
          { name: 'subject_ref', type: 'text' },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('erasure_ledger', true);
  }
}
