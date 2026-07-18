/**
 * Operator auth controller (T-10.7/T-10.33) — API-only (panel 012 consumes it).
 * login/logout + MFA enrolment. No Nunjucks views.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { OperatorAuthService } from './operator-auth.service';
import { OperatorSessionGuard } from './operator-session.guard';
import { MfaService } from './mfa.service';
import { CurrentOperator } from './current-operator.decorator';
import { extractSessionId, type OperatorRequest } from './operator-request';
import type { OperatorSession } from './operator-session.service';

interface LoginBody {
  email?: unknown;
  password?: unknown;
  totpCode?: unknown;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

@Controller('admin/auth')
export class OperatorAuthController {
  constructor(
    private readonly auth: OperatorAuthService,
    private readonly mfa: MfaService,
  ) {}

  @Post('login')
  async login(@Body() body: LoginBody, @Req() req: OperatorRequest): Promise<{ sessionId: string; role: string }> {
    const email = asString(body.email);
    const password = asString(body.password);
    if (email === undefined || password === undefined) {
      throw new BadRequestException('email and password are required');
    }
    const source = req.ip;
    const result = await this.auth.login({ email, password, totpCode: asString(body.totpCode), source });
    return { sessionId: result.sessionId, role: result.session.role };
  }

  @Post('logout')
  @UseGuards(OperatorSessionGuard)
  async logout(@Req() req: OperatorRequest): Promise<{ ok: true }> {
    await this.auth.logout(extractSessionId(req));
    return { ok: true };
  }

  @Get('me')
  @UseGuards(OperatorSessionGuard)
  me(@CurrentOperator() operator: OperatorSession): OperatorSession {
    return operator;
  }

  /**
   * MFA enrolment — returns the raw secret + otpauth URI ONCE (persisting the
   * encrypted secret is a full-account update owned by Unit B's account admin;
   * here we surface the self-hosted enrolment material). Requires a session.
   */
  @Post('mfa/enrol')
  @UseGuards(OperatorSessionGuard)
  enrolMfa(@CurrentOperator() operator: OperatorSession): { secret: string; otpauthUri: string } {
    try {
      const enrolment = this.mfa.enrol(operator.email);
      return { secret: enrolment.secret, otpauthUri: enrolment.otpauthUri };
    } catch {
      throw new UnauthorizedException('MFA enrolment requires SECRET_MASTER_KEY to be configured');
    }
  }
}
