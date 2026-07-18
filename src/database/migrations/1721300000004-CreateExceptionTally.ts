import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * EXCEPTION_TALLY table (T-01.4). Composite PK (game_id, utc_day, reason).
 * reason is plain text — NOT a Postgres enum (the reason set grows across
 * specs; R5). Counts only, arrival-day bucketed.
 */
export class CreateExceptionTally1721300000004 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'exception_tally',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'utc_day', type: 'date', isPrimary: true },
          { name: 'reason', type: 'text', isPrimary: true },
          { name: 'count', type: 'bigint', default: 0 },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('exception_tally', true);
  }
}
