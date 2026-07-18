import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { GameEntity } from './game.entity';

/**
 * GAME_SERVER_CREDENTIAL — the SECRET server credential, 1..N per game (011
 * design §ER, T-10.3). Realizes Foundation §1.2's `GAME.server_credential` scalar
 * as a 1..N child. Created on demand (NOT auto-issued at registration), shown
 * EXACTLY ONCE, then only `credential_hash` + `credential_prefix` + `created_at`
 * persist — the raw secret is never retrievable again (lost ⇒ create a new one,
 * revoke the old).
 *
 * Composite PK `(game_id, credential_id)`: `game_id` TEXT, `credential_id` uuid.
 * Validity is `revoked_at IS NULL` — dual-active rotation by design (create new,
 * deploy, watch old `last_used_at` drain, then revoke old).
 *
 * `credentialPrefix` is the class marker (`sk_…`) visible to secret scanners so a
 * leaked secret is recognizable and an SDK fails fast on a wrong-class key.
 */
@Entity('game_server_credential')
export class GameServerCredentialEntity {
  /** Owning game — TEXT PK part. */
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  /** Local credential id — uuid. Set by the service. */
  @PrimaryColumn({ type: 'uuid' })
  credentialId!: string;

  /** Secret class prefix (`sk_…`) — recognizable to secret scanners. */
  @Column({ type: 'text' })
  credentialPrefix!: string;

  /** Keyed hash of the raw secret (hex). Lookup is by hash; raw never stored. */
  @Column({ type: 'text' })
  credentialHash!: string;

  @Column({ type: 'timestamptz' })
  createdAt!: Date;

  /** Coalesced last-use stamp (off the hot path). Null until first resolved use. */
  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  /** Validity marker — null ⇒ valid. Set to revoke. */
  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @ManyToOne(() => GameEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'game_id' })
  game!: GameEntity;
}
