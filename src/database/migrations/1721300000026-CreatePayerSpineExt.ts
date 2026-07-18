import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * PAYER_SPINE_EXT table ([007-derived-kpis] T, written by 06 on the accept signal).
 * PK (game_id, user_id). Durable-immediate, gate-coupled. NO enforced USER_SPINE FK
 * (payer family is a logical association; Q1 — a never-sessioned payer commits
 * normally). `lifetime_spend_normalized` is the payer-tier source; `has_unconverted_spend`
 * drives the `indeterminate` tier abstention.
 */
export class CreatePayerSpineExt1721300000026 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'payer_spine_ext',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'user_id', type: 'text', isPrimary: true },
          { name: 'first_purchase_day', type: 'date' },
          { name: 'lifetime_spend_normalized', type: 'numeric', precision: 24, scale: 6, default: 0 },
          { name: 'has_unconverted_spend', type: 'boolean', default: false },
        ],
        indices: [
          // First-purchase conversion counts first_purchase_day ∈ period per game.
          { name: 'ix_payer_spine_ext_game_fpd', columnNames: ['game_id', 'first_purchase_day'] },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('payer_spine_ext', true);
  }
}
