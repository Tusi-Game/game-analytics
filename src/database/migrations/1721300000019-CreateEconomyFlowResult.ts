import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * ECONOMY_FLOW_RESULT table (T-03.1). Composite PK
 * (game_id, currency, utc_day, provenance, reason, flow_type). Class-M result cell.
 * `event_count` (BLOCKER-B) is the per-leg event-count companion to `amount_sum`
 * (the low-volume guard compares event COUNTS, which amount_sum cannot hold).
 */
export class CreateEconomyFlowResult1721300000019 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'economy_flow_result',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'currency', type: 'text', isPrimary: true },
          { name: 'utc_day', type: 'date', isPrimary: true },
          { name: 'provenance', type: 'text', isPrimary: true },
          { name: 'reason', type: 'text', isPrimary: true },
          { name: 'flow_type', type: 'text', isPrimary: true },
          { name: 'amount_sum', type: 'bigint', default: 0 },
          { name: 'event_count', type: 'bigint', default: 0 },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('economy_flow_result', true);
  }
}
