import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * ACTIVE_USER_DAY table (T-02.2). Composite PK (game_id, utc_day). Class-S
 * set-union projection; `members` exact user_id set (jsonb array v1).
 */
export class CreateActiveUserDay1721300000016 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'active_user_day',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'utc_day', type: 'date', isPrimary: true },
          { name: 'members', type: 'jsonb', default: "'{}'::jsonb" },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('active_user_day', true);
  }
}
