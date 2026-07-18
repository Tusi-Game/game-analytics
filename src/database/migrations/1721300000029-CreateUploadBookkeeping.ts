import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * UPLOAD_BOOKKEEPING table (T-07.1). Composite PK (game_id, utc_day) — ≤ 1 row
 * per game × corrected-UTC-day file. DIRECT-WRITE, no status enum: presence of a
 * row = "object verified in bucket". `integrity_ref` is jsonb (size + checksum +
 * decode-verdict). `local_deleted_at` nullable = local copy removed by retention.
 *
 * `game_id` is a LOGICAL FK (no physical foreign key — matches the
 * EXCEPTION_TALLY / ERASURE_LEDGER pattern). Table-builder style.
 */
export class CreateUploadBookkeeping1721300000029 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'upload_bookkeeping',
        columns: [
          { name: 'game_id', type: 'text', isPrimary: true },
          { name: 'utc_day', type: 'date', isPrimary: true },
          { name: 'uploaded_at', type: 'timestamptz' },
          { name: 'object_ref', type: 'text' },
          { name: 'integrity_ref', type: 'jsonb' },
          { name: 'local_deleted_at', type: 'timestamptz', isNullable: true },
        ],
      }),
      true,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('upload_bookkeeping', true);
  }
}
