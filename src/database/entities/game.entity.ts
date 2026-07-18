import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { GameConfig } from '../../common/contracts/config';

/**
 * GAME — the per-game registry row (Foundation §1.2, ER-full §1).
 *
 * A registry, NOT a result table. Ingest owns the storage; 011-operator-admin
 * owns the write path (registration/admin API). The credential-child tables
 * (`GAME_SDK_KEY`, `GAME_SERVER_CREDENTIAL`) are 011's and are now the source of
 * truth for auth resolution. The inline `sdkKey` / `serverCredential` scalars are
 * DEPRECATED (migration 012): migrated into hashed child rows and made nullable;
 * nothing reads them anymore (the rewritten resolver reads the child tables).
 * They remain physically for one release as a safe deprecation window.
 *
 * snake_case columns are produced automatically by SnakeNamingStrategy — the
 * properties below are camelCase and MUST NOT carry hand-written `name:`
 * overrides.
 */
@Entity('game')
export class GameEntity {
  /** Server-assigned game identifier. String PK (not bigint) — opaque id. */
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  @Column({ type: 'text' })
  name!: string;

  /**
   * DEPRECATED (migration 012) — the pre-011 inline client credential. Migrated
   * into a hashed `GAME_SDK_KEY` child row and made nullable; the resolver no
   * longer reads it. Kept physically for one deprecation window; do not write it.
   */
  @Column({ type: 'text', nullable: true })
  sdkKey!: string | null;

  /**
   * DEPRECATED (migration 012) — the pre-011 inline server credential. Migrated
   * into a hashed `GAME_SERVER_CREDENTIAL` child row; the resolver no longer reads
   * it. Kept physically for one deprecation window; do not write it.
   */
  @Column({ type: 'text', nullable: true })
  serverCredential!: string | null;

  /**
   * Per-game knobs — every story's §6 config lands in this JSON blob
   * (reporting_offset, caps, etc.). Open-ended by design.
   */
  @Column({ type: 'jsonb', default: {} })
  config!: GameConfig;

  @Column({ type: 'timestamptz' })
  registeredAt!: Date;
}
