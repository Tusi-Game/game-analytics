import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * GAME registry table (T-01.1). game_id text PK, unique sdk_key, nullable hashed
 * server_credential, jsonb config, registered_at.
 */
export class CreateGame1721300000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'game',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'name', type: 'text' },
          { name: 'sdk_key', type: 'text', isUnique: true },
          { name: 'server_credential', type: 'text', isNullable: true },
          { name: 'config', type: 'jsonb', default: "'{}'" },
          { name: 'registered_at', type: 'timestamptz' },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('game', true);
  }
}
