/**
 * Config admin controller (T-11.67-72) — GET /panel/:gameId/config (grouped knob
 * inventory), the inline edit form, PUT (write via ConfigAdminService), and the
 * CONFIG_AUDIT trail. It SURFACES the config-contract registry + effect-timing;
 * it never redefines a knob's semantics. Writes go through {@link
 * ConfigAdminService.set} (the sole config writer, contract-validated, forward-only,
 * emits CONFIG_AUDIT). `viewer` sees read-only rows and the edit/PUT endpoints 403.
 *
 * Platform-scoped knobs (reporting_offset, operator_*, worker_config_cache_*) are
 * shown in a separate "Platform" group as read-only — the write path already
 * refuses a per-game write of a platform knob, so the panel presents them but does
 * not offer per-game editing.
 */

import { Body, Controller, ForbiddenException, Get, Param, Put, Query, Render, Req, UseGuards } from '@nestjs/common';
import { ConfigAdminService } from '../../config/config-admin.service';
import { CONFIG_CONTRACTS, getKnobContract, type KnobContract } from '../../config/config-contract';
import { INFRA_SECRET_KNOBS } from '../../config/config-admin.service';
import { PanelConfigService } from '../panel-config.service';
import { CredentialService } from '../../operator/credential.service';
import { Roles } from '../../operator/roles.decorator';
import { RolesGuard } from '../../operator/roles.guard';
import { CurrentOperator } from '../../operator/current-operator.decorator';
import type { OperatorSession } from '../../operator/operator-session.service';
import { PanelSessionGuard } from '../auth/panel-session.guard';
import { GameAccessGuard, type GameScopedRequest } from '../auth/game-access.guard';

/** One knob row rendered in a group. */
interface KnobRow {
  key: string;
  owner: string;
  effect: string;
  scope: string;
  note: string;
  currentValue: string;
  isSecret: boolean;
  editable: boolean;
  inputType: 'text' | 'number' | 'toggle' | 'json' | 'select';
  enumValues: string[];
}

@Controller('panel')
@UseGuards(PanelSessionGuard)
export class ConfigController {
  constructor(
    private readonly configAdmin: ConfigAdminService,
    private readonly panelConfig: PanelConfigService,
    private readonly credentials: CredentialService,
  ) {}

  @Get(':gameId/config')
  @UseGuards(GameAccessGuard)
  @Render('config/index')
  async index(
    @CurrentOperator() operator: OperatorSession,
    @Param('gameId') gameId: string,
    @Req() req: GameScopedRequest,
    @Query('flash') flash?: string,
  ): Promise<Record<string, unknown>> {
    const s = this.panelConfig.settings();
    const current = await this.configAdmin.get(gameId);
    const isAdmin = operator.role === 'admin';

    // Group per-game knobs by owner; platform knobs go in a dedicated group.
    const perGameGroups = new Map<string, KnobRow[]>();
    const platformRows: KnobRow[] = [];
    for (const c of CONFIG_CONTRACTS) {
      const row = this.toRow(c, current[c.key], isAdmin);
      if (c.scope === 'platform') {
        platformRows.push(row);
      } else {
        const arr = perGameGroups.get(c.owner) ?? [];
        arr.push(row);
        perGameGroups.set(c.owner, arr);
      }
    }

    const groups = [...perGameGroups.entries()].map(([owner, rows]) => ({ owner, rows }));
    const gameName = req.game?.name ?? gameId;
    const games = await this.credentials.listGames();
    return {
      panelTitle: s.panelTitle,
      logoUrl: s.logoUrl,
      operator,
      games,
      nav: 'config',
      gameId,
      gameName,
      pageTitle: `${gameName} · Configuration`,
      breadcrumb: [
        { label: 'Games', href: '/panel/games' },
        { label: gameName, href: `/panel/${gameId}/settings` },
        { label: 'Configuration' },
      ],
      groups,
      platformRows,
      canWrite: isAdmin,
      flash: flashFromQuery(flash),
    };
  }

  /**
   * PUT /panel/:gameId/config/:key — write a knob. Admin-only (RolesGuard); a
   * viewer is 403'd. Delegates validation + audit to ConfigAdminService.set.
   */
  @Put(':gameId/config/:key')
  @UseGuards(GameAccessGuard, RolesGuard)
  @Roles('admin')
  @Render('config/index')
  async update(
    @CurrentOperator() operator: OperatorSession,
    @Param('gameId') gameId: string,
    @Param('key') key: string,
    @Body() body: Record<string, unknown>,
    @Req() req: GameScopedRequest,
  ): Promise<Record<string, unknown>> {
    const contract = getKnobContract(key);
    if (!contract) {
      throw new ForbiddenException(`unknown knob "${key}"`);
    }
    const value = this.coerce(contract, body.value);
    try {
      await this.configAdmin.set(gameId, key, value, operator.operatorId);
      return this.index(operator, gameId, req, `success:Saved ${key}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid value';
      return this.index(operator, gameId, req, `error:${message}`);
    }
  }

  @Get(':gameId/config/audit')
  @UseGuards(GameAccessGuard)
  @Render('config/audit')
  async audit(
    @CurrentOperator() operator: OperatorSession,
    @Param('gameId') gameId: string,
    @Req() req: GameScopedRequest,
  ): Promise<Record<string, unknown>> {
    const s = this.panelConfig.settings();
    const rows = await this.configAdmin.listAudit(gameId);
    const gameName = req.game?.name ?? gameId;
    const games = await this.credentials.listGames();
    return {
      panelTitle: s.panelTitle,
      logoUrl: s.logoUrl,
      operator,
      games,
      nav: 'config',
      gameId,
      gameName,
      pageTitle: `${gameName} · Config audit`,
      breadcrumb: [
        { label: 'Games', href: '/panel/games' },
        { label: gameName, href: `/panel/${gameId}/settings` },
        { label: 'Config audit' },
      ],
      rows,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private toRow(c: KnobContract, currentRaw: unknown, isAdmin: boolean): KnobRow {
    const isSecret = INFRA_SECRET_KNOBS.has(c.key);
    const currentValue = isSecret
      ? '••••••••'
      : currentRaw === undefined
        ? '(default)'
        : typeof currentRaw === 'string'
          ? currentRaw
          : JSON.stringify(currentRaw);
    return {
      key: c.key,
      owner: c.owner,
      effect: c.effect,
      scope: c.scope,
      note: c.note,
      currentValue,
      isSecret,
      // Per-game knobs are editable by admins; platform knobs never (env-sourced).
      editable: isAdmin && c.scope === 'per-game',
      inputType: this.inputType(c),
      enumValues: c.contract.type === 'enum' ? [...c.contract.values] : [],
    };
  }

  private inputType(c: KnobContract): KnobRow['inputType'] {
    switch (c.contract.type) {
      case 'boolean':
        return 'toggle';
      case 'int':
      case 'number':
        return 'number';
      case 'enum':
        return 'select';
      case 'array':
      case 'object':
        return 'json';
      default:
        return 'text';
    }
  }

  /** Coerce the submitted string value into the knob's runtime type. */
  private coerce(c: KnobContract, raw: unknown): unknown {
    const str = typeof raw === 'string' ? raw : '';
    switch (c.contract.type) {
      case 'boolean':
        return str === 'true' || str === 'on' || str === '1';
      case 'int':
        return Number.parseInt(str, 10);
      case 'number':
        return Number(str);
      case 'array':
      case 'object':
        try {
          return JSON.parse(str);
        } catch {
          return str;
        }
      default:
        return str;
    }
  }
}

/** Parse a `flash=type:message` query into a flash object. */
function flashFromQuery(flash: string | undefined): { type: string; message: string } | null {
  if (!flash) {
    return null;
  }
  const idx = flash.indexOf(':');
  return idx === -1 ? { type: 'info', message: flash } : { type: flash.slice(0, idx), message: flash.slice(idx + 1) };
}
