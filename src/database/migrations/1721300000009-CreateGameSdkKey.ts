import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * GAME_SDK_KEY (T-10.2) — public client credential child table, 1..N per game.
 * Composite PK `(game_id, key_id)`; `game_id` TEXT FK → game, `key_id` uuid.
 * `key_prefix` public, `key_hash` (keyed-hash lookup), lifecycle timestamps.
 * A unique index on `key_hash` makes the resolver's hash lookup O(1) and single-row.
 */
export class CreateGameSdkKey1721300000009 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'game_sdk_key',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'key_id', type: 'uuid', isPrimary: true },
          { name: 'key_prefix', type: 'text' },
          { name: 'key_hash', type: 'text' },
          { name: 'created_at', type: 'timestamptz' },
          { name: 'last_used_at', type: 'timestamptz', isNullable: true },
          { name: 'revoked_at', type: 'timestamptz', isNullable: true },
        ],
      }),
      true,
    );
    await queryRunner.createIndex(
      'game_sdk_key',
      new TableIndex({ name: 'ux_game_sdk_key_hash', columnNames: ['key_hash'], isUnique: true }),
    );
    await queryRunner.createForeignKey(
      'game_sdk_key',
      new TableForeignKey({
        columnNames: ['game_id'],
        referencedTableName: 'game',
        referencedColumnNames: ['game_id'],
        onDelete: 'CASCADE',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('game_sdk_key', true);
  }
}
