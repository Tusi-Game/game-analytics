import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * ECONOMY_FLOW_RESULT — per-game × currency × logical-day × provenance × reason ×
 * flow_type running summed amount ([004-economy] design ER row 1, Foundation §1.2,
 * grain refined). Pure result cell; the reason-collapsed rollup is the headline
 * source/sink total. Class-M flushed cell (§3.2.1) — `amount_sum` and `event_count`
 * are both GREATEST-merged (monotone-up in an open day, no-op on retry).
 *
 * `event_count` (BLOCKER-B) is the per-leg event COUNT companion to `amount_sum`
 * (which holds summed magnitudes, not counts). The low-volume guard
 * (`economy_ratio_min_events`) compares per-leg event COUNTS, so `amount_sum`
 * alone cannot satisfy it — one extra flushed class-M value carries the count.
 *
 * BIGINT columns come back from TypeORM as STRINGS — parse before arithmetic.
 * snake_case columns are automatic via SnakeNamingStrategy.
 */
@Entity('economy_flow_result')
export class EconomyFlowResultEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  /** Currency identifier (free-form per-game; each tracked independently). */
  @PrimaryColumn({ type: 'text' })
  currency!: string;

  /** Corrected logical day, DATE (no time-of-day). */
  @PrimaryColumn({ type: 'date' })
  utcDay!: string;

  /** `server` | `client` — derived at ingest from the credential class (§4.5). */
  @PrimaryColumn({ type: 'text' })
  provenance!: string;

  /** Why the flow happened (`quest_reward`, `shop_purchase:sword`, …). */
  @PrimaryColumn({ type: 'text' })
  reason!: string;

  /** `source` | `sink` — direction is carried here, NEVER by amount sign. */
  @PrimaryColumn({ type: 'text' })
  flowType!: string;

  /** Running absolute Σ amount for this cell (class-M GREATEST). */
  @Column({ type: 'bigint', default: 0 })
  amountSum!: string;

  /** Running absolute event COUNT for this cell (class-M GREATEST; BLOCKER-B). */
  @Column({ type: 'bigint', default: 0 })
  eventCount!: string;
}
