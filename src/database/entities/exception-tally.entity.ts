import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { ExceptionReason } from '../../common/contracts/exception-reason';

/**
 * EXCEPTION_TALLY — bare per-reason per-day counts (Foundation §1.2, ER-full).
 *
 * The shared observability surface every story writes tallies to. COUNTS ONLY —
 * never payloads, envelopes, or per-event rows (P1/P7). Lifetime totals are a
 * read-time Σ over day rows; there is no second structure.
 *
 * `utcDay` is ARRIVAL-day bucketed (the server-received day), NOT the corrected
 * logical day — tallies record when the platform observed the problem.
 *
 * `reason` is a plain `text` column, NOT a Postgres enum: the reason set grows
 * across specs, so the {@link ExceptionReason} TS union in
 * `common/contracts/exception-reason.ts` is the sole source of truth (R5).
 *
 * Class-M cell: flushed via `GREATEST`. snake_case columns are automatic.
 */
@Entity('exception_tally')
export class ExceptionTallyEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  /** Arrival day, DATE. */
  @PrimaryColumn({ type: 'date' })
  utcDay!: string;

  /** One of the {@link ExceptionReason} literals. Stored as free text (R5). */
  @PrimaryColumn({ type: 'text' })
  reason!: ExceptionReason;

  /**
   * Absolute count. BIGINT → returned by TypeORM as a STRING; parse before
   * arithmetic.
   */
  @Column({ type: 'bigint', default: 0 })
  count!: string;
}
