/**
 * Admin config controller (T-10.24/25/27/33) — API-only.
 *
 * RBAC (T-10.11): reads (config get, audit list, the contract inventory) are
 * allowed to any authenticated operator (viewer or admin); the config SET write
 * requires @Roles('admin'). OperatorSessionGuard + RolesGuard at the class level.
 *
 * Forward-only + audited (T-10.25/34): every set writes GAME.config + appends
 * exactly one CONFIG_AUDIT row stamped effective_from (ConfigAdminService, the
 * sole config writer, P9). Out-of-contract values are rejected with no write and
 * no audit. The R13 reporting_offset SET-ONCE hard-block is enforced in the
 * service (platform-level + data-exists), surfaced here as a 403.
 *
 * P12: config is per-game scoped — the write/read path is always keyed by the
 * `:gameId` path param; a query never crosses games.
 */

import { BadRequestException, Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ConfigAdminService, type ConfigAuditRow, type ConfigSetResult } from '../config/config-admin.service';
import { CONFIG_CONTRACTS, type KnobContract } from '../config/config-contract';
import { OperatorSessionGuard } from './operator-session.guard';
import { RolesGuard } from './roles.guard';
import { Roles } from './roles.decorator';
import { CurrentOperator } from './current-operator.decorator';
import type { OperatorSession } from './operator-session.service';

@Controller('admin/games/:gameId/config')
@UseGuards(OperatorSessionGuard, RolesGuard)
export class AdminConfigController {
  constructor(private readonly configAdmin: ConfigAdminService) {}

  // ── reads (viewer + admin) ──────────────────────────────────────────────────

  /** The administered knob inventory (contracts + effect-timing labels, T-10.28). */
  @Get('inventory')
  inventory(): readonly KnobContract[] {
    return CONFIG_CONTRACTS;
  }

  /** Read a game's administered config (infra secrets redacted). */
  @Get()
  get(@Param('gameId') gameId: string): Promise<Record<string, unknown>> {
    return this.configAdmin.get(gameId);
  }

  /** List a game's CONFIG_AUDIT trail (newest first) with effective_from (T-10.27). */
  @Get('audit')
  audit(@Param('gameId') gameId: string, @Query('limit') limit?: string): Promise<ConfigAuditRow[]> {
    const n = limit !== undefined && /^\d+$/.test(limit) ? Number(limit) : undefined;
    return this.configAdmin.listAudit(gameId, n);
  }

  // ── write (admin only) ──────────────────────────────────────────────────────

  /**
   * Forward-only config set for one knob. Body: `{ value: <contract-typed> }`.
   * Rejects unknown/platform/out-of-contract knobs before any write.
   */
  @Put(':key')
  @Roles('admin')
  set(
    @Param('gameId') gameId: string,
    @Param('key') key: string,
    @Body() body: { value?: unknown },
    @CurrentOperator() operator: OperatorSession,
  ): Promise<ConfigSetResult> {
    if (!('value' in body)) {
      throw new BadRequestException('request body must include a "value" field');
    }
    return this.configAdmin.set(gameId, key, body.value, operator.operatorId);
  }
}
