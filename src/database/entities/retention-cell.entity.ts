import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * RETENTION_CELL — per-game × cohort × day-offset retained-user count
 * ([005-retention] design ER, Foundation §1.2). Projection of spine bits; SPARSE
 * — only touched offsets materialize, an absent MATURE cell reads 0. The
 * `(cohort × offset)` set of rows IS the heatmap triangle.
 *
 * Class-M flushed projection. `retainedUsers` increments once per reported 0→1
 * bit transition (sequence B / 8b), keyed on the cohort day `c` and the offset
 * `N` (the activity day is `c + N`, which is the Redis bucket day, not this PK).
 *
 * BIGINT → STRING from TypeORM. snake_case columns via SnakeNamingStrategy.
 */
@Entity('retention_cell')
export class RetentionCellEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  /** Cohort (install) logical day, DATE. */
  @PrimaryColumn({ type: 'date' })
  cohortDate!: string;

  /** Day-offset from `first_seen` (0 = install day). */
  @PrimaryColumn({ type: 'int' })
  dayOffset!: number;

  @Column({ type: 'bigint', default: 0 })
  retainedUsers!: string;
}
