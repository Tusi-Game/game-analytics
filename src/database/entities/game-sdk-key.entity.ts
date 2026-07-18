import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { GameEntity } from './game.entity';

/**
 * GAME_SDK_KEY — the public client credential, 1..N per game (011 design §ER,
 * T-10.2). Realizes Foundation §1.2's `GAME.sdk_key` scalar as a child table so a
 * game can hold ≥ 2 active keys during rotation (shipped builds can never be
 * updated — a new key ships in the next build while the old stays valid).
 *
 * Composite PK `(game_id, key_id)`: `game_id` is TEXT (the platform keys on the
 * opaque game id), `key_id` is a locally-generated `uuid`. Validity is
 * `revoked_at IS NULL` — NO "active" boolean; the resolver accepts ANY non-revoked
 * row (this is what enables dual-active rotation).
 *
 * `keyPrefix` is the public class marker (`pk_…`, viewable in admin). `keyHash`
 * is a keyed hash of the raw key (SecretCryptoService HMAC) — the raw key is
 * shown once at issue and never stored. `lastUsedAt` is stamped off the hot path
 * (Redis-coalesced, flushed by the periodic sweep) so the operator can watch a
 * rotated key drain.
 */
@Entity('game_sdk_key')
export class GameSdkKeyEntity {
  /** Owning game — TEXT PK part (platform keys on the opaque game id). */
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  /** Local key id — uuid (shown/referenced, not bigint). Set by the service. */
  @PrimaryColumn({ type: 'uuid' })
  keyId!: string;

  /** Public class prefix (`pk_…`), safe to display; aids fast-fail + scanners. */
  @Column({ type: 'text' })
  keyPrefix!: string;

  /** Keyed hash of the raw key (hex). Lookup is by hash; the raw key is never stored. */
  @Column({ type: 'text' })
  keyHash!: string;

  @Column({ type: 'timestamptz' })
  createdAt!: Date;

  /** Coalesced last-use stamp (off the hot path). Null until first resolved use. */
  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  /** Validity marker — null ⇒ valid. Set to revoke (emergency for sdk_key). */
  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @ManyToOne(() => GameEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'game_id' })
  game!: GameEntity;
}
