import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * SESSION_DAY_RESULT — per-game × logical-day session aggregates ([003-sessions]
 * design ER, Foundation §1.2). Pure result cell; 1 row per game × corrected
 * logical day. NO per-session rows.
 *
 * Class-M flushed projection (rebuildable only from the raw day file — manual,
 * cold-storage — NOT a spine re-scan):
 *   - `sessionCount`     — start-day keyed, write-once semantics (a session is
 *                          counted once, in its START day).
 *   - `durationSumMs`    — split-attributed via `dur_on_day` (a midnight-spanning
 *                          session contributes to at most two adjacent days).
 *   - `sessionsTouching` — count of sessions with any overlap on the day; the
 *                          coherent denominator for the split-form average. Equals
 *                          `sessionCount` except on days a spanning session's tail
 *                          lands.
 *
 * BIGINT columns come back from TypeORM as STRINGS — parse before arithmetic.
 * snake_case columns are automatic via SnakeNamingStrategy.
 */
@Entity('session_day_result')
export class SessionDayResultEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  /** Corrected logical day, DATE (no time-of-day). */
  @PrimaryColumn({ type: 'date' })
  utcDay!: string;

  @Column({ type: 'bigint', default: 0 })
  sessionCount!: string;

  @Column({ type: 'bigint', default: 0 })
  durationSumMs!: string;

  @Column({ type: 'bigint', default: 0 })
  sessionsTouching!: string;
}
