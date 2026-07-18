import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { GameConfig } from '../../common/contracts/config';

/**
 * GAME — the per-game registry row (Foundation §1.2, ER-full §1).
 *
 * A registry, NOT a result table. Ingest owns the storage; 011-operator-admin
 * owns the write path (registration/admin API). The full credential-child
 * tables (`GAME_SDK_KEY`, `GAME_SERVER_CREDENTIAL`) are 011's — this phase keeps
 * only the scalar `sdk_key` / `server_credential` read surface needed to make
 * ingest auth testable before 011 exists (see `src/seed.ts`, T-01.6).
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
   * Public-by-design client credential. Client SDKs authenticate with this;
   * resolving it server-side yields `provenance=client` (§4.5). UNIQUE so a key
   * maps to exactly one game.
   */
  @Column({ type: 'text', unique: true })
  sdkKey!: string;

  /**
   * Secret server credential — a minimal pre-011 auth read surface that is
   * compared as plaintext for now. Nullable — a game may have no server-scope
   * credential. Resolving it yields `provenance=server`. 011 realises the full
   * 1..N `GAME_SERVER_CREDENTIAL` child table with HASHED storage + show-once and
   * migrates this scalar away; do not rely on this column holding a hash yet.
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
