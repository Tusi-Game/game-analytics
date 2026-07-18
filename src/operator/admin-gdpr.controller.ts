/**
 * Admin GDPR controller (T-10.29-32/33) — API-only. Surfaces 002's erasure + DSAR
 * jobs behind operator attestation.
 *
 * RBAC: ALL routes are @Roles('admin'). An erasure destroys data and a DSAR
 * export is a full per-user dump — a viewer must never reach either. Every
 * trigger records an attestation row (GdprAdminService → GDPR_REQUEST_AUDIT).
 *
 * P12: erasure/DSAR are keyed by `:gameId`; the awaiting_seal surface is scoped
 * to a game when `:gameId` is given.
 */

import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { GdprAdminService, type StuckErasureRequest } from './gdpr-admin.service';
import type { ErasureResult } from '../gdpr/erasure.service';
import type { DsarExport } from '../gdpr/dsar.service';
import { OperatorSessionGuard } from './operator-session.guard';
import { RolesGuard } from './roles.guard';
import { Roles } from './roles.decorator';
import { CurrentOperator } from './current-operator.decorator';
import type { OperatorSession } from './operator-session.service';

interface GdprTriggerBody {
  userId?: unknown;
  attestation?: unknown;
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new BadRequestException(`${name} is required`);
  }
  return v.trim();
}

@Controller('admin')
@UseGuards(OperatorSessionGuard, RolesGuard)
export class AdminGdprController {
  constructor(private readonly gdpr: GdprAdminService) {}

  /**
   * Operator-verified ERASURE trigger (T-10.29). Body:
   * `{ userId, attestation }`. Records the attestation, invokes ErasureService.
   */
  @Post('games/:gameId/gdpr/erasure')
  @Roles('admin')
  erasure(
    @Param('gameId') gameId: string,
    @Body() body: GdprTriggerBody,
    @CurrentOperator() operator: OperatorSession,
  ): Promise<ErasureResult> {
    return this.gdpr.triggerErasure({
      gameId,
      userId: requireString(body.userId, 'userId'),
      attestation: requireString(body.attestation, 'attestation'),
      operatorId: operator.operatorId,
    });
  }

  /**
   * Operator-verified DSAR-access / portability trigger (T-10.31/32). Body:
   * `{ userId, attestation }`. Returns the machine-readable export incl. the
   * Art. 11 boundary in its scope_note.
   */
  @Post('games/:gameId/gdpr/dsar')
  @Roles('admin')
  dsar(
    @Param('gameId') gameId: string,
    @Body() body: GdprTriggerBody,
    @CurrentOperator() operator: OperatorSession,
  ): Promise<DsarExport> {
    return this.gdpr.triggerDsar({
      gameId,
      userId: requireString(body.userId, 'userId'),
      attestation: requireString(body.attestation, 'attestation'),
      operatorId: operator.operatorId,
    });
  }

  /** Surface erasure requests stuck in `awaiting_seal` for a game (T-10.30). */
  @Get('games/:gameId/gdpr/awaiting-seal')
  @Roles('admin')
  awaitingSealForGame(@Param('gameId') gameId: string): Promise<StuckErasureRequest[]> {
    return this.gdpr.listStuckAwaitingSeal(gameId);
  }

  /** Surface ALL awaiting_seal erasure requests across the operator's games (T-10.30). */
  @Get('gdpr/awaiting-seal')
  @Roles('admin')
  awaitingSealAll(): Promise<StuckErasureRequest[]> {
    return this.gdpr.listStuckAwaitingSeal();
  }
}
