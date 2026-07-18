import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { EventKind } from '../../common/contracts/envelope';

/**
 * A key → set-of-observed-types map. Stores property KEYS and their observed
 * scalar TYPES only — NEVER values (P1: values are a PII vector and violate the
 * results-only store split). The array is the union of every type seen for the
 * key; drift is derived at read time.
 */
export type PropertyTypeSets = Record<string, string[]>;

/**
 * EVENT_CATALOG — day-less per-name catalog (Foundation §1.2, ER-full).
 *
 * Discovers event names per game. Day-less and NEVER seals: `first_seen` only
 * ever moves DOWN (LEAST/min merge — load-bearing, OF-2), `last_seen`/`count`
 * only move UP (GREATEST/max merge), `propertyTypeSets` unions. See the mixed
 * per-field flush rule (foundation §3.2.1) — 002 owns this merge.
 *
 * snake_case columns are automatic via SnakeNamingStrategy.
 */
@Entity('event_catalog')
export class EventCatalogEntity {
  @PrimaryColumn({ type: 'text' })
  gameId!: string;

  @PrimaryColumn({ type: 'text' })
  eventName!: string;

  /** Resolved kind (declared, overridden for reserved names per §H-2). */
  @Column({ type: 'text' })
  kind!: EventKind;

  /** v1 always `accepted`. */
  @Column({ type: 'text', default: 'accepted' })
  status!: string;

  @Column({ type: 'timestamptz' })
  firstSeen!: Date;

  @Column({ type: 'timestamptz' })
  lastSeen!: Date;

  /**
   * Lifetime occurrence count (approximate-OK). BIGINT — TypeORM returns bigint
   * as a STRING, so this property is typed `string` and callers must parse it.
   */
  @Column({ type: 'bigint', default: 0 })
  lifetimeCount!: string;

  /** key → observed-type set. Types only, never values (P1). */
  @Column({ type: 'jsonb', default: {} })
  propertyTypeSets!: PropertyTypeSets;
}
