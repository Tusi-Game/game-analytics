/**
 * Per-domain durable FLOOR provider for the economy hot path (rehydrate-on-miss,
 * Foundation §2.3). This is the seam's floor-extension pattern (default-hooks.ts):
 * the story INJECTS ITS OWN floor provider scoped to its domains (`eco`/`eco:seg`
 * and the per-entry `bal` point-read) and calls it directly inside the economy hot
 * hook — it NEVER touches the generic {@link FloorProvider} (cnt/cat/exc), so
 * there is no shared mutation point (collision-free by construction).
 *
 * A missing durable row → an empty floor; the first hot increment establishes the
 * value on top of the durable floor (HSETNX seed → HINCRBY). Each flow cell has
 * TWO measures (amount_sum + event_count, BLOCKER-B), seeded as two tagged hash
 * fields (`a␟…` and `n␟…`).
 *
 *   - {@link ecoFloor}    `{game}:eco:{day}`      ← ECONOMY_FLOW_RESULT
 *   - {@link ecoSegFloor} `{game}:eco:{day}:seg`  ← ECONOMY_FLOW_SEGMENT_RESULT
 *   - {@link balPointRead} per-entry `bal:{cur}` seed ← BALANCE_SNAPSHOT row
 *
 * BIGINT columns come back from TypeORM as STRINGS and stay strings end-to-end.
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { DurableFloor } from '../common/redis-keys/rehydrate';
import { EconomyFlowResultEntity } from '../database/entities/economy-flow-result.entity';
import { EconomyFlowSegmentResultEntity } from '../database/entities/economy-flow-segment-result.entity';
import { BalanceSnapshotEntity } from '../database/entities/balance-snapshot.entity';
import {
  ecoField,
  ecoSegField,
  MEASURE_AMOUNT,
  MEASURE_COUNT,
  type BalanceEntry,
  type FlowType,
  type Provenance,
  type SegmentDim,
} from './eco-keys';

@Injectable()
export class EconomyFloorProvider {
  constructor(private readonly dataSource: DataSource) {}

  /** Floor for an `eco:{day}` base hash: durable amount_sum + event_count per cell. */
  async ecoFloor(gameId: string, utcDay: string): Promise<DurableFloor> {
    const rows = await this.dataSource.getRepository(EconomyFlowResultEntity).find({
      where: { gameId, utcDay },
      select: { provenance: true, flowType: true, currency: true, reason: true, amountSum: true, eventCount: true },
    });
    const fields: Record<string, string> = {};
    for (const r of rows) {
      const prov = r.provenance as Provenance;
      const flow = r.flowType as FlowType;
      fields[ecoField(MEASURE_AMOUNT, prov, flow, r.currency, r.reason)] = r.amountSum;
      fields[ecoField(MEASURE_COUNT, prov, flow, r.currency, r.reason)] = r.eventCount;
    }
    return { fields };
  }

  /** Floor for an `eco:{day}:seg` hash: durable amount_sum + event_count per segment cell. */
  async ecoSegFloor(gameId: string, utcDay: string): Promise<DurableFloor> {
    const rows = await this.dataSource.getRepository(EconomyFlowSegmentResultEntity).find({
      where: { gameId, utcDay },
      select: {
        provenance: true,
        flowType: true,
        currency: true,
        segmentDim: true,
        segmentValue: true,
        reason: true,
        amountSum: true,
        eventCount: true,
      },
    });
    const fields: Record<string, string> = {};
    for (const r of rows) {
      const prov = r.provenance as Provenance;
      const flow = r.flowType as FlowType;
      const dim = r.segmentDim as SegmentDim;
      fields[ecoSegField(MEASURE_AMOUNT, prov, flow, r.currency, dim, r.segmentValue, r.reason)] = r.amountSum;
      fields[ecoSegField(MEASURE_COUNT, prov, flow, r.currency, dim, r.segmentValue, r.reason)] = r.eventCount;
    }
    return { fields };
  }

  /**
   * Per-entry durable point-read for the `bal` LWW rehydrate-on-miss (T-03.23):
   * seed a MISSING `bal:{currency}` hash entry from the durable BALANCE_SNAPSHOT
   * row before comparing as_of. No row ⇒ null (accept the incoming write). This is
   * a POINT read per (user, currency), NOT a whole-bucket seed — the `bal` hash
   * has no day-scoped floor to seed wholesale (it is day-less and huge).
   */
  async balPointRead(gameId: string, userId: string, currency: string): Promise<BalanceEntry | null> {
    const row = await this.dataSource.getRepository(BalanceSnapshotEntity).findOne({
      where: { gameId, userId, currency },
      select: { lastKnownBalance: true, asOf: true, provenance: true },
    });
    if (!row) {
      return null;
    }
    const asOfMs = row.asOf.getTime();
    // Durable rows carry no tie-break metadata (the flush guard is `as_of >=`), so
    // seed NEUTRAL tie-break keys: an incoming hot event with a strictly-later
    // as_of wins normally; an equal-as_of hot event compares its real
    // server_received/event_id against this neutral (server_received = as_of, id '').
    return {
      balance: row.lastKnownBalance,
      asOfMs,
      provenance: row.provenance,
      serverReceivedMs: asOfMs,
      eventId: '',
    };
  }
}
