/**
 * Operator accounts controller (T-11.79-81) — admin-only account management via
 * {@link OperatorAdminService} (the new sanctioned write-path; research brief §9
 * blocker 1). List / create / edit / disable / enable, plus MFA reset. Accounts
 * are never hard-deleted (disable sets disabled_at). `viewer` is 403'd on every
 * route (class-level @Roles('admin')).
 */

import { Body, Controller, Get, Param, Post, Query, Render, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { OperatorAdminService } from '../../operator/operator-admin.service';
import type { OperatorRole } from '../../database/entities/operator-account.entity';
import { PanelConfigService } from '../panel-config.service';
import { CredentialService } from '../../operator/credential.service';
import { Roles } from '../../operator/roles.decorator';
import { RolesGuard } from '../../operator/roles.guard';
import { CurrentOperator } from '../../operator/current-operator.decorator';
import type { OperatorSession } from '../../operator/operator-session.service';
import { PanelSessionGuard } from '../auth/panel-session.guard';

@Controller('panel/operators')
@UseGuards(PanelSessionGuard, RolesGuard)
@Roles('admin')
export class OperatorsController {
  constructor(
    private readonly admin: OperatorAdminService,
    private readonly panelConfig: PanelConfigService,
    private readonly credentials: CredentialService,
  ) {}

  private async chrome(operator: OperatorSession): Promise<Record<string, unknown>> {
    const s = this.panelConfig.settings();
    const games = await this.credentials.listGames();
    return { panelTitle: s.panelTitle, logoUrl: s.logoUrl, operator, games, nav: 'operators' };
  }

  @Get()
  @Render('operators/list')
  async list(
    @CurrentOperator() operator: OperatorSession,
    @Query('flash') flash?: string,
  ): Promise<Record<string, unknown>> {
    const chrome = await this.chrome(operator);
    const operators = await this.admin.list();
    return {
      ...chrome,
      pageTitle: 'Operators',
      breadcrumb: [{ label: 'Operators' }],
      operators,
      flash: flashFromQuery(flash),
    };
  }

  @Get('new')
  @Render('operators/form')
  async newForm(@CurrentOperator() operator: OperatorSession): Promise<Record<string, unknown>> {
    const chrome = await this.chrome(operator);
    return {
      ...chrome,
      pageTitle: 'New operator',
      breadcrumb: [{ label: 'Operators', href: '/panel/operators' }, { label: 'New' }],
      isNew: true,
      account: { operatorId: '', email: '', role: 'viewer', mfaEnrolled: false, disabled: false },
    };
  }

  @Get(':operatorId/edit')
  @Render('operators/form')
  async editForm(
    @CurrentOperator() operator: OperatorSession,
    @Param('operatorId') operatorId: string,
  ): Promise<Record<string, unknown>> {
    const chrome = await this.chrome(operator);
    const account = await this.admin.get(operatorId);
    return {
      ...chrome,
      pageTitle: `Edit ${account.email}`,
      breadcrumb: [{ label: 'Operators', href: '/panel/operators' }, { label: account.email }],
      isNew: false,
      account,
    };
  }

  @Post()
  async create(@Body() body: Record<string, unknown>, @Req() req: Request, @Res() res: Response): Promise<void> {
    const email = typeof body.email === 'string' ? body.email : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const role = normalizeRole(body.role);
    try {
      await this.admin.create({ email, password, role });
      redirect(res, req, '/panel/operators?flash=success:Operator+created');
    } catch (err) {
      redirect(
        res,
        req,
        `/panel/operators?flash=error:${encodeURIComponent(err instanceof Error ? err.message : 'create failed')}`,
      );
    }
  }

  @Post(':operatorId')
  async edit(
    @Param('operatorId') operatorId: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const email = typeof body.email === 'string' ? body.email : undefined;
    const password = typeof body.password === 'string' && body.password.length > 0 ? body.password : undefined;
    const role = body.role !== undefined ? normalizeRole(body.role) : undefined;
    try {
      await this.admin.edit(operatorId, { email, password, role });
      redirect(res, req, '/panel/operators?flash=success:Operator+updated');
    } catch (err) {
      redirect(
        res,
        req,
        `/panel/operators?flash=error:${encodeURIComponent(err instanceof Error ? err.message : 'update failed')}`,
      );
    }
  }

  @Post(':operatorId/disable')
  async disable(@Param('operatorId') operatorId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.admin.disable(operatorId);
    redirect(res, req, '/panel/operators?flash=warning:Operator+disabled');
  }

  @Post(':operatorId/enable')
  async enable(@Param('operatorId') operatorId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.admin.enable(operatorId);
    redirect(res, req, '/panel/operators?flash=success:Operator+re-enabled');
  }

  @Post(':operatorId/reset-mfa')
  async resetMfa(@Param('operatorId') operatorId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.admin.resetMfa(operatorId);
    redirect(res, req, '/panel/operators?flash=warning:MFA+reset+for+operator');
  }
}

function normalizeRole(raw: unknown): OperatorRole {
  return raw === 'admin' ? 'admin' : 'viewer';
}

function redirect(res: Response, req: Request, to: string): void {
  if (req.headers['hx-request'] === 'true') {
    res.setHeader('HX-Redirect', to);
    res.status(200).send();
  } else {
    res.redirect(302, to);
  }
}

function flashFromQuery(flash: string | undefined): { type: string; message: string } | null {
  if (!flash) {
    return null;
  }
  const idx = flash.indexOf(':');
  return idx === -1 ? { type: 'info', message: flash } : { type: flash.slice(0, idx), message: flash.slice(idx + 1) };
}
