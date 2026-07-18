import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { SdkKeyGuard } from './guards/sdk-key.guard';
import { OperatorSessionGuard } from './guards/operator-session.guard';
import { AppValidationPipe } from './pipes/validation.pipe';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { LoggingInterceptor } from './interceptors/logging.interceptor';
import { RehydrateService } from './redis-keys/rehydrate';
import { WindowedDedupGate, UnimplementedPurchaseDedupGate, PURCHASE_DEDUP_GATE } from './kernel/dedup';

/**
 * Shared kernel module (@Global).
 *
 * Exports cross-cutting NestJS plumbing that every story module reuses:
 *   - guards (SDK-key auth, operator session) — bound per-route by consumers;
 *   - the validation pipe skeleton;
 *   - the exception filter and logging interceptor, registered globally here.
 *
 * Being `@Global`, its exported providers are injectable everywhere without
 * re-importing the module. Contract interfaces live in `./contracts` and are
 * imported directly as types (no DI needed).
 *
 * Zero application logic — pure contracts + NestJS cross-cutting plumbing.
 */
@Global()
@Module({
  providers: [
    // Guards are exported for consumers to bind per-route (e.g. @UseGuards(SdkKeyGuard)).
    SdkKeyGuard,
    OperatorSessionGuard,
    AppValidationPipe,
    // Rehydrate-on-miss + seeded-marker machinery (foundation §2.3, P10).
    RehydrateService,
    // Dedup — windowed (002-owned) + the durable purchase-gate SEAM (006 fills).
    WindowedDedupGate,
    { provide: PURCHASE_DEDUP_GATE, useClass: UnimplementedPurchaseDedupGate },
    // Global exception filter and request-logging interceptor.
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
  exports: [
    SdkKeyGuard,
    OperatorSessionGuard,
    AppValidationPipe,
    RehydrateService,
    WindowedDedupGate,
    PURCHASE_DEDUP_GATE,
  ],
})
export class CommonModule {}
