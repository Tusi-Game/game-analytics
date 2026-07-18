import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * EVENT_DAY_COUNT table (T-01.3). Composite PK (game_id, event_name, utc_day).
 * No stored grand total — read-time Σ over day rows.
 */
export class CreateEventDayCount1721300000003 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'event_day_count',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'event_name', type: 'text', isPrimary: true },
          { name: 'utc_day', type: 'date', isPrimary: true },
          { name: 'count', type: 'bigint', default: 0 },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('event_day_count', true);
  }
}
