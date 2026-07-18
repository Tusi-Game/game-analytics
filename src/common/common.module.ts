import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AppValidationPipe } from './pipes/validation.pipe';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { LoggingInterceptor } from './interceptors/logging.interceptor';
import { RehydrateService } from './redis-keys/rehydrate';
import { WindowedDedupGate, UnimplementedPurchaseDedupGate, PURCHASE_DEDUP_GATE } from './kernel/dedup';

/**
 * Shared kernel module (@Global).
 *
 * Exports cross-cutting NestJS plumbing that every story module reuses:
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
    // The dead operator-session guard SKELETON was retired in 012: panel routes
    // use the cookie-transport PanelSessionGuard and /v1/dashboard/* uses the real
    // bearer operator/OperatorSessionGuard. The SdkKeyGuard skeleton was likewise
    // retired in 011 Unit B (the real IngestAuthGuard owns the only credential-
    // authed route).
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
  exports: [AppValidationPipe, RehydrateService, WindowedDedupGate, PURCHASE_DEDUP_GATE],
})
export class CommonModule {}
