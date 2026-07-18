import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * FX_RATE table ([006-monetization] R9). PK (game_id, currency, rate_date). The
 * durable dated rate the hot-path as-of lookup reads (most recent rate_date ≤
 * purchase_day, valid iff within fx_staleness_max_days). Materialized from the
 * envelope-encrypted `fx_table` CONFIG material by the reconciliation job (decrypt
 * happens ONLY in-worker; the hot path reads this plaintext table).
 */
export class CreateFxRate1721300000028 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'fx_rate',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'currency', type: 'text', isPrimary: true },
          { name: 'rate_date', type: 'date', isPrimary: true },
          { name: 'rate', type: 'numeric', precision: 24, scale: 10, default: 0 },
        ],
        indices: [
          // As-of lookup: most recent rate_date ≤ purchase_day for (game, currency).
          { name: 'ix_fx_rate_game_cur_date', columnNames: ['game_id', 'currency', 'rate_date'] },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('fx_rate', true);
  }
}
