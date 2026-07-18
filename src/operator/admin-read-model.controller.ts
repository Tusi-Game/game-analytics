/**
 * Admin read-model controller (T-10.35/33) — API-only. The operator's PG-direct
 * results read surface, behind the REAL operator session guard + RBAC.
 *
 * P12 (per-game scoped): every read is keyed by the `:gameId` path param — a
 * query NEVER crosses games, even though an operator has cross-game ACCESS. The
 * merge itself (live Redis ∪ durable Postgres, GREATEST per name) is 002's
 * ReadModelService, reused here (Foundation §5 "direct" dashboard path, never
 * through the flush; no Redis merge for operational metadata — but result day
 * counts ARE a live-vs-durable merge, which is the read-model's job).
 *
 * Reads are allowed to any authenticated operator (viewer or admin) — no @Roles,
 * so a viewer can read results (design.md §ER: viewer reads, cannot write).
 */

import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ReadModelService, type DayCounts } from '../dashboard/read-model.service';
import { utcDay } from '../common/kernel/logical-day';
import { OperatorSessionGuard } from './operator-session.guard';
import { RolesGuard } from './roles.guard';

@Controller('admin/games/:gameId/results')
@UseGuards(OperatorSessionGuard, RolesGuard)
export class AdminReadModelController {
  constructor(private readonly readModel: ReadModelService) {}

  /**
   * `GET /admin/games/:gameId/results/counts?day=YYYY-MM-DD` — merged per-name day
   * counts (live Redis ∪ durable Postgres) + read-time Σ grand total for ONE game
   * (P12). `day` defaults to the current UTC day when omitted/malformed.
   */
  @Get('counts')
  counts(@Param('gameId') gameId: string, @Query('day') day?: string): Promise<DayCounts> {
    const resolvedDay = day !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : utcDay(Date.now());
    return this.readModel.dayCounts(gameId, resolvedDay);
  }
}
