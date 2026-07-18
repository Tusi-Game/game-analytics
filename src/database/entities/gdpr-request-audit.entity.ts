import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { GameEntity } from './game.entity';
import { OperatorAccountEntity } from './operator-account.entity';

/** The kind of GDPR request an operator triggered. */
export const GDPR_REQUEST_KINDS = ['erasure', 'dsar_access'] as const;
export type GdprRequestKind = (typeof GDPR_REQUEST_KINDS)[number];

/**
 * GDPR_REQUEST_AUDIT (T-10.29/T-10.31) — the operator ATTESTATION trail for GDPR
 * erasure + DSAR-access triggers.
 *
 * Identity verification is the studio's MANUAL duty (mirroring Matomo) — the
 * platform cannot prove the requester is the subject. What it CAN do, and must,
 * is record that an operator attested a verified request was made (design.md
 * §Relations; tasks §4 "over-trusting this surface is a data-exfil risk"). An
 * erasure destroys data; a DSAR-access export is a full per-user dump — so every
 * trigger is behind admin RBAC AND audited here with the attesting operator,
 * subject reference, attestation text, and outcome.
 *
 * `subjectRef` is a keyed hash of the subject's user_id (SubjectHashService),
 * NEVER the plaintext user_id — the audit must not itself become a store of
 * erased/exported subjects' identities (mirrors ERASURE_LEDGER).
 *
 * snake_case columns are automatic via SnakeNamingStrategy.
 */
@Entity('gdpr_request_audit')
export class GdprRequestAuditEntity {
  @PrimaryGeneratedColumn('uuid')
  auditId!: string;

  /** Owning game (per-game scope, P12). */
  @Column({ type: 'text' })
  gameId!: string;

  /** The operator who attested + triggered the request. */
  @Column({ type: 'uuid' })
  operatorId!: string;

  /** `erasure` | `dsar_access`. Plain text; the union is the source of truth. */
  @Column({ type: 'text' })
  kind!: GdprRequestKind;

  /** Per-game KEYED HASH of the subject's user_id — NEVER plaintext. */
  @Column({ type: 'text' })
  subjectRef!: string;

  /** The operator's attestation note (what verification was performed). */
  @Column({ type: 'text' })
  attestation!: string;

  /** Resulting status (e.g. erasure `pending`/`awaiting_seal`/`executed`, dsar `assembled`). */
  @Column({ type: 'text' })
  outcome!: string;

  @Column({ type: 'timestamptz' })
  requestedAt!: Date;

  @ManyToOne(() => GameEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'game_id' })
  game!: GameEntity;

  @ManyToOne(() => OperatorAccountEntity, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'operator_id' })
  operator!: OperatorAccountEntity;
}
