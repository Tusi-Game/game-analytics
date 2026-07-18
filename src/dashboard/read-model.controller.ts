/**
 * Dashboard read-model endpoint STUB (T-01.41). A thin JSON surface over
 * {@link ReadModelService} so the live-vs-historical merge is reachable; the full
 * panel (spec 012) builds the rich UI on top. Guarded by the operator session
 * guard (dashboard is operator-facing, not public ingest).
 */

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { OperatorSessionGuard } from '../common/guards/operator-session.guard';
import { ReadModelService, type DayCounts } from './read-model.service';
import { utcDay } from '../common/kernel/logical-day';

@Controller('v1/dashboard')
@UseGuards(OperatorSessionGuard)
export class ReadModelController {
  constructor(private readonly readModel: ReadModelService) {}

  /**
   * `GET /v1/dashboard/:gameId/counts?day=YYYY-MM-DD` — merged per-name day counts
   * (live Redis ∪ durable Postgres) + read-time Σ grand total. `day` defaults to
   * the current UTC day when omitted.
   */
  @Get(':gameId/counts')
  async counts(@Param('gameId') gameId: string, @Query('day') day?: string): Promise<DayCounts> {
    const resolvedDay = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : utcDay(Date.now());
    return this.readModel.dayCounts(gameId, resolvedDay);
  }
}
