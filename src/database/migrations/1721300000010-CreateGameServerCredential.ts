import { MigrationInterface, QueryRunner, Table, TableForeignKey, TableIndex } from 'typeorm';

/**
 * GAME_SERVER_CREDENTIAL (T-10.3) — secret server credential child table, 1..N
 * per game. Composite PK `(game_id, credential_id)`; `game_id` TEXT FK → game,
 * `credential_id` uuid. `credential_prefix`, `credential_hash` (keyed-hash
 * lookup), lifecycle timestamps. Unique index on `credential_hash` for O(1)
 * single-row resolver lookup.
 */
export class CreateGameServerCredential1721300000010 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'game_server_credential',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'credential_id', type: 'uuid', isPrimary: true },
          { name: 'credential_prefix', type: 'text' },
          { name: 'credential_hash', type: 'text' },
          { name: 'created_at', type: 'timestamptz' },
          { name: 'last_used_at', type: 'timestamptz', isNullable: true },
          { name: 'revoked_at', type: 'timestamptz', isNullable: true },
        ],
      }),
      true,
    );
    await queryRunner.createIndex(
      'game_server_credential',
      new TableIndex({ name: 'ux_game_server_credential_hash', columnNames: ['credential_hash'], isUnique: true }),
    );
    await queryRunner.createForeignKey(
      'game_server_credential',
      new TableForeignKey({
        columnNames: ['game_id'],
        referencedTableName: 'game',
        referencedColumnNames: ['game_id'],
        onDelete: 'CASCADE',
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('game_server_credential', true);
  }
}
