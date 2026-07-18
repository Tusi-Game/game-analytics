import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * MONETIZATION_CELL table ([006-monetization] T). Composite PK
 * (game_id, product_id, dim_combo, utc_day). Class-N flushed cell: `gen` smallint is
 * the generation gate (WHERE EXCLUDED.gen >= target.gen); GREATEST FORBIDDEN because
 * the enrichment MOVE decrements counts/revenue. `revenue_local_breakdown` (jsonb) is
 * the unsealed re-normalization source.
 */
export class CreateMonetizationCell1721300000024 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'monetization_cell',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'product_id', type: 'text', isPrimary: true },
          { name: 'dim_combo', type: 'text', isPrimary: true },
          { name: 'utc_day', type: 'date', isPrimary: true },
          { name: 'purchase_count', type: 'bigint', default: 0 },
          { name: 'revenue_normalized', type: 'numeric', precision: 24, scale: 6, default: 0 },
          { name: 'product_category', type: 'text', default: "''" },
          { name: 'revenue_local_breakdown', type: 'jsonb', default: "'{}'::jsonb" },
          { name: 'gen', type: 'smallint', default: 0 },
        ],
        indices: [
          // Read model + reconciliation scan by (game, day).
          { name: 'ix_mon_cell_game_day', columnNames: ['game_id', 'utc_day'] },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('monetization_cell', true);
  }
}
