import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * USER_SPINE — the ONLY per-user durable structure in phases 02/04 (SC-007).
 * Owned by [005-retention]; WRITTEN by [003-sessions]'s session path
 * (durable-immediate, step 7, bridge 02.5 sequences A + B). Foundation §1.3
 * core-spine tier.
 *
 * DURABLE-IMMEDIATE (P7): both columns go STRAIGHT to Postgres in step 7, BEFORE
 * any Redis write, NEVER flush-mediated. A Redis crash cannot un-retain a user
 * whose bit already landed.
 *
 *   - `firstSeen`         — write-once (insert-if-absent); value = corrected
 *                           session_start of the user's FIRST accepted `session`
 *                           event. Its logical day is the cohort + Day-0 anchor.
 *   - `activeDaysBitmap`  — Postgres `bit varying`; one bit per day-offset from
 *                           `first_seen`. Set-once per offset via a single
 *                           `set_bit()` UPDATE with a `get_bit()=0` guard that
 *                           RETURNs the 0→1 transition. Span default 45
 *                           (max(retention_day_targets)=30 + ~15 headroom).
 *
 * `firstSeen` is `timestamptz` (stored UTC epoch — its logical-day floor is
 * derived at read/offset time via `reporting_offset`, never re-applied). The
 * bitmap is a fixed-width `bit(N)` seeded all-zero at insert so `set_bit()` never
 * hits an out-of-range offset within the span; over-horizon offsets are a
 * caller-side silent no-op (see SessionDurableHook).
 *
 * snake_case columns are automatic via SnakeNamingStrategy.
 */
@Entity('user_spine')
export class UserSpineEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  @PrimaryColumn({ type: 'text' })
  userId!: string;

  /** Write-once first accepted session start (UTC epoch). */
  @Column({ type: 'timestamptz' })
  firstSeen!: Date;

  /**
   * Fixed-width bit string, one bit per day-offset from `first_seen`. TypeORM has
   * no first-class `bit varying` type, so it is declared as a raw column type;
   * the driver returns/accepts it as a `'0101…'` string. All mutation goes
   * through `set_bit()`/`get_bit()` SQL, never the ORM.
   */
  @Column({ type: 'bit varying' })
  activeDaysBitmap!: string;
}
