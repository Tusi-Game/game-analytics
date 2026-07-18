import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * PURCHASE_IDEMPOTENCY table ([006-monetization] T). `transaction_id` is the PRIMARY
 * KEY (hence UNIQUE) — the durable, never-windowed money dedup. `ON CONFLICT
 * (transaction_id) DO NOTHING` is the claim. NOT a spine, NOT a result — an
 * idempotency-key table permitted alongside the user spine (Foundation §1.3).
 * Payer family (game_id, user_id) is a LOGICAL association — NO enforced USER_SPINE FK.
 */
export class CreatePurchaseIdempotency1721300000023 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'purchase_idempotency',
        columns: [
          { name: 'transaction_id', type: 'text', isPrimary: true },
          { name: 'original_transaction_id', type: 'text' },
          { name: 'game_id', type: 'text' },
          { name: 'user_id', type: 'text' },
          { name: 'purchase_day', type: 'date' },
          { name: 'price_local', type: 'numeric', precision: 20, scale: 6, default: 0 },
          { name: 'currency', type: 'text' },
          { name: 'product_id', type: 'text' },
          { name: 'refunded', type: 'boolean', default: false },
        ],
        indices: [
          // The PAYER_DAY rebuild + reconciliation re-derivations scan by (game, day).
          { name: 'ix_purchase_idem_game_day', columnNames: ['game_id', 'purchase_day'] },
          // Payer-set / lifetime-spend re-derivations scan by (game, user).
          { name: 'ix_purchase_idem_game_user', columnNames: ['game_id', 'user_id'] },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('purchase_idempotency', true);
  }
}
