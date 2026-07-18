/**
 * Durable-data-exists predicate (T-10.24, R13/P8) — THE load-bearing guard behind
 * the `reporting_offset` set-once hard-block.
 *
 * `reporting_offset` defines the platform logical day for ALL metrics + seals
 * (design.md §Config inventory; Foundation §4.7). It is PLATFORM-level (env
 * REPORTING_OFFSET), correctness-bearing, and SET-ONCE at install. Editing it
 * after any durable result/spine row exists would silently re-bucket sealed
 * history — a forbidden forward-rebuild (out of v1). Nothing structural prevents
 * the edit, so this predicate is P8's only teeth: the admin config-write path
 * (ConfigAdminService) calls {@link anyDurableDataExists} and HARD-BLOCKS the
 * edit when it is true.
 *
 * "Durable data" = any row in the durable result/spine tables: EVENT_DAY_COUNT
 * (the day-count spine), EVENT_CATALOG, EXCEPTION_TALLY. As later specs add spine
 * tiers (PAYER_SPINE_EXT, …), extend {@link DURABLE_RESULT_TABLES} — the guard is
 * intentionally an OR over the durable set so a single sealed cell anywhere is
 * enough to lock the offset. The check is a cheap `EXISTS (SELECT 1 … LIMIT 1)`
 * per table, short-circuiting on the first hit.
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EventDayCountEntity } from '../database/entities/event-day-count.entity';
import { EventCatalogEntity } from '../database/entities/event-catalog.entity';
import { ExceptionTallyEntity } from '../database/entities/exception-tally.entity';

/**
 * The durable result/spine tables whose presence locks `reporting_offset`. Add
 * later spine tiers here as they land (they are all offset-bucketed).
 */
const DURABLE_RESULT_ENTITIES = [EventDayCountEntity, EventCatalogEntity, ExceptionTallyEntity] as const;

/** Human names for the guard's error message / diagnostics. */
export const DURABLE_RESULT_TABLES = ['event_day_count', 'event_catalog', 'exception_tally'] as const;

@Injectable()
export class DataExistsService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * True iff ANY durable result/spine row exists anywhere on the platform. Used
   * to hard-block a `reporting_offset` edit (R13). Platform-wide (offset is
   * platform-level), so it is NOT game-scoped.
   */
  async anyDurableDataExists(): Promise<boolean> {
    for (const entity of DURABLE_RESULT_ENTITIES) {
      const row = await this.dataSource.getRepository(entity).createQueryBuilder('t').select('1').limit(1).getRawOne();
      if (row !== undefined && row !== null) {
        return true;
      }
    }
    return false;
  }
}
