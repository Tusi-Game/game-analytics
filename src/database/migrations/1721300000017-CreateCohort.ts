import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * COHORT table (T-04.3). Composite PK (game_id, cohort_date). Class-M projection
 * of spine first_seen days; ≤ 1 row per game × logical day with ≥ 1 new user.
 */
export class CreateCohort1721300000017 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'cohort',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'cohort_date', type: 'date', isPrimary: true },
          { name: 'cohort_size', type: 'bigint', default: 0 },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('cohort', true);
  }
}
