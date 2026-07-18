import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * SESSION_DAY_RESULT table (T-02.1). Composite PK (game_id, utc_day). Class-M
 * result cell; 1 row per game × corrected logical day. No per-session rows.
 */
export class CreateSessionDayResult1721300000015 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'session_day_result',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'utc_day', type: 'date', isPrimary: true },
          { name: 'session_count', type: 'bigint', default: 0 },
          { name: 'duration_sum_ms', type: 'bigint', default: 0 },
          { name: 'sessions_touching', type: 'bigint', default: 0 },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('session_day_result', true);
  }
}
