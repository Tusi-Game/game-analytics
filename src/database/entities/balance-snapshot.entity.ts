import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * BALANCE_SNAPSHOT — the class-L exemplar ([004-economy] design ER row 3,
 * Foundation §1.2/§1.3 tier-3 opt-in). Per-user last-known balance per currency:
 * an UPSERT-LATEST snapshot, NOT an append log — no per-event balance history is
 * ever stored (P1). Written only while `economy_depth_capture_mode` is on.
 *
 * DAY-LESS and NOT seal-governed. Its mutability is governed by `as_of`
 * last-writer-wins, NOT by the day seal — a balance legitimately FALLS, so
 * GREATEST-on-balance is FORBIDDEN. The flush merge for this table is class L
 * (`WHERE EXCLUDED.as_of >= balance_snapshot.as_of`) — a stale as_of never
 * clobbers a newer one.
 *
 *   - `lastKnownBalance` — the balance_after of the LWW-winning economy event.
 *   - `asOf`             — corrected event-time of that last writer (the LWW guard).
 *   - `provenance`       — provenance of the last writer; ADVISORY, non-key.
 *
 * `user_id` is a LOGICAL FK to USER_SPINE, NOT enforced (Q1: economy seeds no
 * spine row) — a balance row may exist with no USER_SPINE parent.
 *
 * BIGINT → STRING from TypeORM. snake_case columns via SnakeNamingStrategy.
 */
@Entity('balance_snapshot')
export class BalanceSnapshotEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  /** Logical (unenforced) FK to USER_SPINE — economy seeds no spine (Q1). */
  @PrimaryColumn({ type: 'text' })
  userId!: string;

  @PrimaryColumn({ type: 'text' })
  currency!: string;

  /** Last-known balance of this currency for this user (may fall — LWW, not max). */
  @Column({ type: 'bigint', default: 0 })
  lastKnownBalance!: string;

  /** Corrected event-time of the last writer (the LWW guard column). */
  @Column({ type: 'timestamptz' })
  asOf!: Date;

  /** Provenance of the last writer — ADVISORY (non-key). */
  @Column({ type: 'text' })
  provenance!: string;
}
