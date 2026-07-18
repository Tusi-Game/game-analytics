import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { GameEntity } from './game.entity';
import { OperatorAccountEntity } from './operator-account.entity';

/**
 * CONFIG_AUDIT — the APPEND-ONLY forward-only config change trail (011 design
 * §ER, T-10.4). One row per config change. `effective_from` is the processing-
 * time watermark at which workers begin honoring the change — the read model uses
 * it to explain a dimension-era / FX-era boundary. Never updated, never deleted.
 *
 * Composite PK `(game_id, audit_id)`: `game_id` TEXT, `audit_id` uuid.
 * `operatorId` FK records who made the change. `old_value`/`new_value` are `text`
 * (any knob serialized) so the trail is knob-agnostic.
 *
 * Note: config WRITES (GameConfigService write path) are Unit B — this entity +
 * migration land in Unit A so the schema is complete and the audit surface exists.
 */
@Entity('config_audit')
export class ConfigAuditEntity {
  /** Owning game — TEXT PK part. */
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  /** Local audit id — uuid. Set by the service. */
  @PrimaryColumn({ type: 'uuid' })
  auditId!: string;

  /** The operator who made the change (FK OPERATOR_ACCOUNT). */
  @Column({ type: 'uuid' })
  operatorId!: string;

  /** The §6 knob that changed. */
  @Column({ type: 'text' })
  configKey!: string;

  /** Serialized prior value (text; null if the knob had no prior value). */
  @Column({ type: 'text', nullable: true })
  oldValue!: string | null;

  /** Serialized new value (text). */
  @Column({ type: 'text' })
  newValue!: string;

  @Column({ type: 'timestamptz' })
  changedAt!: Date;

  /** Processing-time watermark from which workers honor the change (forward-only). */
  @Column({ type: 'timestamptz' })
  effectiveFrom!: Date;

  @ManyToOne(() => GameEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'game_id' })
  game!: GameEntity;

  @ManyToOne(() => OperatorAccountEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'operator_id' })
  operator!: OperatorAccountEntity;
}
