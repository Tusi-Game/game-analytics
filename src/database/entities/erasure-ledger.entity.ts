import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Lifecycle states of an erasure request (ops-envelope §7.5). */
export const ERASURE_STATUSES = ['pending', 'awaiting_seal', 'executed'] as const;
export type ErasureStatus = (typeof ERASURE_STATUSES)[number];

/**
 * ERASURE_LEDGER — per-request GDPR erasure state (ops-envelope §7.5, ER-full).
 *
 * Operational request-keyed state under GAME, NOT a spine tier. `subjectRef` is
 * a per-game KEYED HASH of the `user_id` — NEVER the plaintext user_id (Q7):
 * the ledger must not itself become a store of erasure subjects' identities.
 *
 * Status column is plain `text`; the {@link ErasureStatus} union is the source
 * of truth. snake_case columns are automatic via SnakeNamingStrategy.
 */
@Entity('erasure_ledger')
export class ErasureLedgerEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  @PrimaryColumn({ type: 'text' })
  requestId!: string;

  @Column({ type: 'timestamptz' })
  requestedAt!: Date;

  @Column({ type: 'text', default: 'pending' })
  status!: ErasureStatus;

  @Column({ type: 'timestamptz', nullable: true })
  executedAt!: Date | null;

  /** Per-game keyed HASH of the user_id. NEVER plaintext (Q7). */
  @Column({ type: 'text' })
  subjectRef!: string;
}
