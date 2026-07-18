import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * PAYER_DAY table ([006-monetization] T). PK (game_id, utc_day). MIXED class:
 * `payer_members` (jsonb array) flushes class-S set-union; `revenue_day_total`
 * (numeric) flushes class-N guarded by its OWN `gen` column (GREATEST FORBIDDEN —
 * FX recompute mutates it downward). Rebuildable exactly from PURCHASE_IDEMPOTENCY.
 */
export class CreatePayerDay1721300000025 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'payer_day',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'utc_day', type: 'date', isPrimary: true },
          { name: 'payer_members', type: 'jsonb', default: "'{}'::jsonb" },
          { name: 'revenue_day_total', type: 'numeric', precision: 24, scale: 6, default: 0 },
          { name: 'gen', type: 'smallint', default: 0 },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('payer_day', true);
  }
}
