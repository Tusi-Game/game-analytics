import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * ECONOMY_SUPPLY_DAY table (T-03.4, Q5) — snapshot-at-seal money-supply level.
 * Composite PK (game_id, currency, utc_day). Write-once at day-seal by reading the
 * durable BALANCE_SNAPSHOT rows; a third durable class beside result cells and
 * spine touches. `depth_percentiles` is jsonb (holds p50/p90/…).
 */
export class CreateEconomySupplyDay1721300000022 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'economy_supply_day',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'currency', type: 'text', isPrimary: true },
          { name: 'utc_day', type: 'date', isPrimary: true },
          { name: 'money_supply', type: 'bigint', default: 0 },
          { name: 'depth_percentiles', type: 'jsonb', default: "'{}'::jsonb" },
          { name: 'n_users', type: 'int', default: 0 },
          { name: 'trusted_supply', type: 'bigint', default: 0 },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('economy_supply_day', true);
  }
}
