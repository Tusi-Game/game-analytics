import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * ECONOMY_FLOW_SEGMENT_RESULT — the segmented sibling of ECONOMY_FLOW_RESULT
 * ([004-economy] design ER row 2). Base grain + `segment_dim × segment_value`;
 * INDEPENDENT per-dim axes only (a sum of small axes — level_bucket, region —
 * never the level×region cross-product). Observed segments materialize as rows
 * only; an event missing a dim contributes nothing to that axis.
 *
 * Same class-M flush as the base table: `amount_sum` + `event_count` GREATEST.
 *
 * BIGINT → STRING from TypeORM. snake_case columns via SnakeNamingStrategy.
 */
@Entity('economy_flow_segment_result')
export class EconomyFlowSegmentResultEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  @PrimaryColumn({ type: 'text' })
  currency!: string;

  @PrimaryColumn({ type: 'date' })
  utcDay!: string;

  @PrimaryColumn({ type: 'text' })
  provenance!: string;

  /** `level_bucket` | `region` — the segment axis. */
  @PrimaryColumn({ type: 'text' })
  segmentDim!: string;

  /** The observed value on that axis (e.g. `L10-19`, `EU`). */
  @PrimaryColumn({ type: 'text' })
  segmentValue!: string;

  @PrimaryColumn({ type: 'text' })
  reason!: string;

  @PrimaryColumn({ type: 'text' })
  flowType!: string;

  @Column({ type: 'bigint', default: 0 })
  amountSum!: string;

  @Column({ type: 'bigint', default: 0 })
  eventCount!: string;
}
