import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * ACTIVE_USER_DAY — per-game × logical-day exact set of `user_id`s with a session
 * START that day ([003-sessions] design ER, Foundation §1.2).
 *
 * Class-S flushed structure (set-union, never blind replace; `PFMERGE` only under
 * the HLL scale lever — HLL is FORBIDDEN for retention membership, allowed here
 * only for count-only DAU under the lever). `members` is the exact `user_id` set
 * in v1, stored as a jsonb OBJECT map (`{ "<user_id>": true }`) so the class-S
 * flush merges by jsonb `||` object-union — a true idempotent set-union with no
 * duplicate accumulation across flushes (an array `||` would CONCAT, not union;
 * this mirrors the proven `event_catalog.property_type_sets` pattern). It is also
 * a **projection** of the spine `active_days_bitmap` (rebuildable via spine
 * re-scan, kept for read speed) — the key set ⊆ that game's `USER_SPINE` users.
 *
 * snake_case columns are automatic via SnakeNamingStrategy.
 */
@Entity('active_user_day')
export class ActiveUserDayEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  /** Corrected logical day, DATE (no time-of-day). */
  @PrimaryColumn({ type: 'date' })
  utcDay!: string;

  /** Exact `user_id` set as a jsonb object map (`{ "<user_id>": true }`). */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  members!: Record<string, true>;
}
