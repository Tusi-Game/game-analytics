import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * ECONOMY_FLOW_SEGMENT_RESULT table (T-03.2). Base grain + (segment_dim,
 * segment_value). Independent per-dim axes only (no level×region cross-product);
 * observed segments materialize as rows only. Class-M result cell with the same
 * `amount_sum` + `event_count` companions as the base table.
 */
export class CreateEconomyFlowSegmentResult1721300000020 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'economy_flow_segment_result',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'currency', type: 'text', isPrimary: true },
          { name: 'utc_day', type: 'date', isPrimary: true },
          { name: 'provenance', type: 'text', isPrimary: true },
          { name: 'segment_dim', type: 'text', isPrimary: true },
          { name: 'segment_value', type: 'text', isPrimary: true },
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
    await queryRunner.dropTable('economy_flow_segment_result', true);
  }
}
