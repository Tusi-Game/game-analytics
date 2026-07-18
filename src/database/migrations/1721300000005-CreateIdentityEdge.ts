import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * IDENTITY_EDGE table (T-01/T-00.16). Composite PK (game_id, anon_id, user_id).
 * Append-only operational link, not a spine tier.
 */
export class CreateIdentityEdge1721300000005 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'identity_edge',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'anon_id', type: 'text', isPrimary: true },
          { name: 'user_id', type: 'text', isPrimary: true },
          { name: 'first_linked_at', type: 'timestamptz' },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('identity_edge', true);
  }
}
