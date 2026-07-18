import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * PAYER_PERIOD_SPEND table ([007-derived-kpis] T). PK (game_id, period, user_id),
 * period = UTC month `YYYY-MM`. The whale distribution — ranked + top-X%-summed at
 * read time. Durable-immediate, gate-coupled (same atomic unit as the transaction_id
 * gate insert, so the cumulative add is exactly-once).
 */
export class CreatePayerPeriodSpend1721300000027 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'payer_period_spend',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'period', type: 'text', isPrimary: true },
          { name: 'user_id', type: 'text', isPrimary: true },
          { name: 'spend_normalized', type: 'numeric', precision: 24, scale: 6, default: 0 },
        ],
        indices: [
          // Whale ranking scans + sorts by (game, period) desc on spend.
          { name: 'ix_payer_period_spend_game_period', columnNames: ['game_id', 'period'] },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('payer_period_spend', true);
  }
}
