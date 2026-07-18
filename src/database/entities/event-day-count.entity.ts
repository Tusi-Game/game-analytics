import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * EVENT_DAY_COUNT — per-name per-day accepted-event count (Foundation §1.2).
 *
 * Class-M cell (monotonic within its day): flushed via `GREATEST`. There is NO
 * stored grand total — `live_total` is a read-time Σ over these day rows
 * (OF-3). `utcDay` is the event's corrected LOGICAL day (§4.7).
 *
 * snake_case columns are automatic via SnakeNamingStrategy.
 */
@Entity('event_day_count')
export class EventDayCountEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  @PrimaryColumn({ type: 'text' })
  eventName!: string;

  /** Corrected logical day, DATE (no time-of-day). */
  @PrimaryColumn({ type: 'date' })
  utcDay!: string;

  /**
   * Absolute day count. BIGINT → TypeORM returns it as a STRING; parse before
   * arithmetic.
   */
  @Column({ type: 'bigint', default: 0 })
  count!: string;
}
