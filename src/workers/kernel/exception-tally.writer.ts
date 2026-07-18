/**
 * Exception-tally writer (T-01.30, foundation §1.2) — the shared observability
 * surface every drop/quarantine increments.
 *
 * Tallies are ARRIVAL-day bucketed (DARK-SPOT #4c): a tally records WHEN the
 * platform observed the problem, keyed on the server-received day, never the
 * event's corrected day — this keeps tallies out of sealed days by construction.
 *
 * Written to the `{game_id}:cnt:{arrival_day}:exc` Redis hash (field = reason,
 * class M via HINCRBY) with the same rehydrate-on-miss + dirty-mark contract as
 * `cnt`, so the flusher upserts it into EXCEPTION_TALLY. COUNTS ONLY — never a
 * payload (P1). The marker append into the raw file (for quarantines) has already
 * happened in step 4 BEFORE this increment (bridge 01.5 §3 ordering).
 */

import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.constants';
import { IngestKeys } from '../../common/redis-keys/redis-keys';
import { RehydrateService } from '../../common/redis-keys/rehydrate';
import { DirtyRegistry } from '../flush/dirty-registry';
import type { ExceptionReason } from '../../common/contracts/exception-reason';
import { FLOOR_PROVIDER, type FloorProvider } from './default-hooks';

/** Reserved cnt:exc metadata fields (HSETNX; read by the exc flush projector). */
export const EXC_FIELD_GAME_ID = '__game_id';
export const EXC_FIELD_UTC_DAY = '__utc_day';

@Injectable()
export class ExceptionTallyWriter {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly rehydrate: RehydrateService,
    private readonly dirty: DirtyRegistry,
    @Inject(FLOOR_PROVIDER) private readonly floors: FloorProvider,
  ) {}

  /**
   * Increment a reason's tally on the ARRIVAL day. Rehydrate-on-miss from the
   * durable floor, HINCRBY the reason, HSETNX the projection metadata, mark dirty.
   */
  async tally(gameId: string, arrivalDay: string, reason: ExceptionReason): Promise<void> {
    const key = IngestKeys.cntExc(gameId, arrivalDay);
    // Rehydrate from the durable EXCEPTION_TALLY floor (per-reason absolutes) so a
    // post-crash flush cannot clobber durable tallies with near-zero values; the
    // seeded marker must be present or the flusher skips the bucket.
    await this.rehydrate.seedIfMissing(key, await this.floors.excFloor(gameId, arrivalDay));
    await this.redis.hincrby(key, reason, 1);
    await this.redis.hsetnx(key, EXC_FIELD_GAME_ID, gameId);
    await this.redis.hsetnx(key, EXC_FIELD_UTC_DAY, arrivalDay);
    await this.dirty.mark('cnt', key);
  }
}
