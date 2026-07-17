import { Controller, Get } from '@nestjs/common';

interface HealthStatus {
  status: 'ok';
  uptime: number;
  timestamp: number;
}

/**
 * Liveness endpoint (FR-008). The docker-compose healthcheck target and the
 * first smoke test after clone. No auth.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthStatus {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: Date.now(),
    };
  }
}
