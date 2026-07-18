import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * USER_SPINE table (T-04.1). Composite PK (game_id, user_id). The core per-user
 * spine tier (SC-007 — the sole per-user draw for phases 02/04).
 *
 * `first_seen` timestamptz — write-once (insert-if-absent). `active_days_bitmap`
 * Postgres `bit varying` — set-once bits via set_bit()/get_bit(); span sized by
 * the caller (default 45) and seeded all-zero at insert. Durable-immediate (P7):
 * both columns are written straight to Postgres in step 7.
 */
export class CreateUserSpine1721300000014 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'user_spine',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'user_id', type: 'text', isPrimary: true },
          { name: 'first_seen', type: 'timestamptz' },
          { name: 'active_days_bitmap', type: 'bit varying' },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('user_spine', true);
  }
}
