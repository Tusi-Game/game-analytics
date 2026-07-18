import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * COHORT — per-game × install-date cohort size ([005-retention] design ER,
 * Foundation §1.2). Projection of spine `first_seen` days; ≤ 1 row per game ×
 * logical day with ≥ 1 new user.
 *
 * Class-M flushed projection. `cohortSize` increments once per created spine row
 * (sequence A / 8a). Invariant (D0 = 100 %): `cohortSize ≡ RETENTION_CELL(c, 0)`
 * for every cohort day `c`.
 *
 * BIGINT → STRING from TypeORM. snake_case columns via SnakeNamingStrategy.
 */
@Entity('cohort')
export class CohortEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  /** Cohort (install) logical day = logical_day(first_seen), DATE. */
  @PrimaryColumn({ type: 'date' })
  cohortDate!: string;

  @Column({ type: 'bigint', default: 0 })
  cohortSize!: string;
}
