import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface HealthStatus {
  status: 'ok';
  uptime: number;
  timestamp: number;
  /** Security posture signal (FR-029) — operator boot check. */
  security: {
    /** True iff SECRET_MASTER_KEY is set (envelope-encryption + keyed hash active). */
    master_key_configured: boolean;
    /** True iff the ingest door refuses plain-HTTP bearer auth. */
    require_tls: boolean;
  };
}

/**
 * Liveness endpoint (FR-008). The docker-compose healthcheck target and the
 * first smoke test after clone. No auth. Also surfaces the FR-029 security
 * posture so an operator can confirm the out-of-DB master key + TLS refusal are
 * configured before trusting the deploy (T-00.84 boot signal).
 */
@Controller('health')
export class HealthController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  check(): HealthStatus {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: Date.now(),
      security: {
        master_key_configured: (this.config.get<string>('SECRET_MASTER_KEY') ?? '').trim() !== '',
        require_tls: this.config.get<boolean>('REQUIRE_TLS') ?? false,
      },
    };
  }
}
