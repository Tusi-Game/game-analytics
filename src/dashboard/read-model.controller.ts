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
import { SessionReadService, type SessionDayView, type SessionWindowView } from '../sessions/session-read.service';
import { RetentionReadService, type HeadlineView, type RetentionCellView } from '../sessions/retention-read.service';

@Controller('v1/dashboard')
@UseGuards(OperatorSessionGuard)
export class ReadModelController {
  constructor(
    private readonly readModel: ReadModelService,
    private readonly sessionRead: SessionReadService,
    private readonly retentionRead: RetentionReadService,
  ) {}

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

  /**
   * `GET /v1/dashboard/:gameId/sessions?day=YYYY-MM-DD` — per-day session count,
   * split-form average length, and provisional flag.
   */
  @Get(':gameId/sessions')
  async sessions(@Param('gameId') gameId: string, @Query('day') day?: string): Promise<SessionDayView> {
    const resolvedDay = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : utcDay(Date.now());
    return this.sessionRead.sessionDay(gameId, resolvedDay);
  }

  /**
   * `GET /v1/dashboard/:gameId/sessions/window?from=&to=` — sessions/user +
   * frequency over an inclusive day window.
   */
  @Get(':gameId/sessions/window')
  async sessionWindow(
    @Param('gameId') gameId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<SessionWindowView> {
    const f = /^\d{4}-\d{2}-\d{2}$/.test(from ?? '') ? from : utcDay(Date.now());
    const t = /^\d{4}-\d{2}-\d{2}$/.test(to ?? '') ? to : utcDay(Date.now());
    return this.sessionRead.window(gameId, f, t);
  }

  /**
   * `GET /v1/dashboard/:gameId/retention/headline` — classic Day-N headline
   * (D1/D7/D30…) over the fixed mature-cohort set.
   */
  @Get(':gameId/retention/headline')
  async retentionHeadline(@Param('gameId') gameId: string): Promise<HeadlineView[]> {
    return this.retentionRead.headline(gameId);
  }

  /**
   * `GET /v1/dashboard/:gameId/retention/heatmap` — the cohort × offset triangle
   * with immature (N/A) + small-cohort (low-confidence) masks applied.
   */
  @Get(':gameId/retention/heatmap')
  async retentionHeatmap(@Param('gameId') gameId: string): Promise<RetentionCellView[]> {
    return this.retentionRead.heatmap(gameId);
  }
}
