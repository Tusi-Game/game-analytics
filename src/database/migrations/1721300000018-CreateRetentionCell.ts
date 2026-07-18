import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * RETENTION_CELL table (T-04.4). Composite PK (game_id, cohort_date, day_offset).
 * Class-M sparse projection of spine bits; the (cohort × offset) rows ARE the
 * heatmap triangle. An absent mature cell reads 0.
 */
export class CreateRetentionCell1721300000018 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'retention_cell',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'cohort_date', type: 'date', isPrimary: true },
          { name: 'day_offset', type: 'int', isPrimary: true },
          { name: 'retained_users', type: 'bigint', default: 0 },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('retention_cell', true);
  }
}
