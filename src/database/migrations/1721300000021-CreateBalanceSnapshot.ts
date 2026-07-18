import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * BALANCE_SNAPSHOT table (T-03.3) — the class-L exemplar. Composite PK
 * (game_id, user_id, currency). Day-less, NOT seal-governed; `as_of` is the LWW
 * guard column (a balance legitimately falls — GREATEST is FORBIDDEN). `user_id`
 * is a LOGICAL FK to USER_SPINE, NOT enforced (Q1: economy seeds no spine row).
 */
export class CreateBalanceSnapshot1721300000021 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'balance_snapshot',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'user_id', type: 'text', isPrimary: true },
          { name: 'currency', type: 'text', isPrimary: true },
          { name: 'last_known_balance', type: 'bigint', default: 0 },
          { name: 'as_of', type: 'timestamptz' },
          { name: 'provenance', type: 'text' },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('balance_snapshot', true);
  }
}
