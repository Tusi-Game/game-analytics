import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * IDENTITY_EDGE — append-only anon→user link (Foundation §4.6, §1.2).
 *
 * OPERATIONAL scope, NOT a spine tier and consumed by no v1 metric. Captured
 * now so a future retroactive identity stitch stays recoverable. Append-only:
 * once an (game_id, anon_id, user_id) edge exists it is never mutated.
 *
 * snake_case columns are automatic via SnakeNamingStrategy.
 */
@Entity('identity_edge')
export class IdentityEdgeEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  @PrimaryColumn({ type: 'text' })
  anonId!: string;

  @PrimaryColumn({ type: 'text' })
  userId!: string;

  @Column({ type: 'timestamptz' })
  firstLinkedAt!: Date;
}
