import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * EVENT_CATALOG table (T-01.2). Day-less, composite PK (game_id, event_name).
 * property_type_sets stores key -> type-set only, never values (P1).
 */
export class CreateEventCatalog1721300000002 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'event_catalog',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'event_name', type: 'text', isPrimary: true },
          { name: 'kind', type: 'text' },
          { name: 'status', type: 'text', default: "'accepted'" },
          { name: 'first_seen', type: 'timestamptz' },
          { name: 'last_seen', type: 'timestamptz' },
          { name: 'lifetime_count', type: 'bigint', default: 0 },
          { name: 'property_type_sets', type: 'jsonb', default: "'{}'" },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('event_catalog', true);
  }
}
