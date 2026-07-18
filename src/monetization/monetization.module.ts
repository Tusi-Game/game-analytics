import { Module, type Provider } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { AppConfigModule } from '../config/app-config.module';
import { SecurityModule } from '../security/security.module';
import { WorkersModule } from '../workers/workers.module';
import {
  KIND_VALIDATOR_REGISTRATION,
  KIND_DURABLE_REGISTRATION,
  KIND_HOT_REGISTRATION,
  type KindValidatorRegistration,
  type KindDurableRegistration,
  type KindHotRegistration,
} from '../workers/kernel/kind-dispatch';
import {
  EXTRA_DOMAIN_FLUSH_PLANS,
  EXTRA_CLASS_N_FLUSH_PLANS,
  type ExtraDomainFlushPlan,
  type ExtraClassNFlushPlan,
} from '../workers/flush/flush-job.service';
import { PURCHASE_DEDUP_GATE } from '../common/kernel/dedup';
import { PurchaseValidator } from './purchase-validator';
import { PurchaseDurableHook } from './purchase-durable.hook';
import { PurchaseHotHook } from './purchase-hot.hook';
import { PurchaseDedupGateService } from './purchase-dedup-gate.service';
import { FxService } from './fx.service';
import { MonetizationConfigService } from './monetization-config.service';
import { CardinalityGuardService } from './cardinality-guard.service';
import { MonetizationFloorProvider } from './monetization-floor.provider';
import { MonetizationReadService } from './monetization-read.service';
import { ReconciliationService } from './reconciliation.service';
import { MON_CELL_FLUSH_PLAN, REV_DAY_FLUSH_PLAN, PAYER_MEMBERS_FLUSH_PLAN } from './monetization-flush-plans';

/**
 * Segmented Monetization + Derived KPIs (combined, [006-monetization] + [007-derived-kpis]
 * per bridge 05.5). ONE module: 007's payer-spine writes ride 006's step-7 purchase-accept
 * atomic unit (there is exactly one money-write site and it lives in the purchase worker).
 *
 * ============ Dispatcher registration (additive, collision-free) ============
 * Imports {@link WorkersModule} so the kind dispatchers + FlushJobService are in scope,
 * then contributes via the seam's MULTI-PROVIDER tokens:
 *   - KIND_VALIDATOR_REGISTRATION → { kind: 'purchase', validator: PurchaseValidator }
 *   - KIND_DURABLE_REGISTRATION   → { kind: 'purchase', hook: PurchaseDurableHook }
 *                                   (the REAL step-7 05→06 atomic unit)
 *   - KIND_HOT_REGISTRATION       → { kind: 'purchase', hook: PurchaseHotHook }
 *                                   (mon/payer/rev accumulators ONLY — the dispatcher
 *                                    runs the generic cat/cnt/rank base FIRST)
 *   - EXTRA_DOMAIN_FLUSH_PLANS    → payer (class S set-union)
 *   - EXTRA_CLASS_N_FLUSH_PLANS   → mon (MONETIZATION_CELL) + rev (PAYER_DAY.revenue) —
 *                                   the atomic Lua-snapshot class-N flush (build gap 2)
 *
 * ============ SANCTIONED REBIND: PURCHASE_DEDUP_GATE ============
 * 002 bound PURCHASE_DEDUP_GATE → UnimplementedPurchaseDedupGate (throw-on-use). This
 * module OVERRIDES that single binding with the REAL durable
 * {@link PurchaseDedupGateService} (build gap 1). A single-binding rebind (NOT a
 * multi-provider) — the last module to provide the token wins; only 006 provides it, so
 * there is no collision. AppModule imports MonetizationModule after WorkersModule so this
 * override is the effective binding.
 *
 * Story-owned floor provider ({@link MonetizationFloorProvider}) is injected into the hot
 * hook directly — never the generic FLOOR_PROVIDER (seam's per-domain floor pattern).
 */

type MultiFactoryProvider = {
  provide: string;
  multi: true;
  inject: unknown[];
  useFactory: (...args: never[]) => unknown;
};
type MultiValueProvider = { provide: string; multi: true; useValue: unknown };

const MONETIZATION_REGISTRATIONS: Provider[] = [
  {
    provide: KIND_VALIDATOR_REGISTRATION,
    multi: true,
    inject: [PurchaseValidator],
    useFactory: (validator: PurchaseValidator): KindValidatorRegistration => ({ kind: 'purchase', validator }),
  } satisfies MultiFactoryProvider as unknown as Provider,
  {
    provide: KIND_DURABLE_REGISTRATION,
    multi: true,
    inject: [PurchaseDurableHook],
    useFactory: (hook: PurchaseDurableHook): KindDurableRegistration => ({ kind: 'purchase', hook }),
  } satisfies MultiFactoryProvider as unknown as Provider,
  {
    provide: KIND_HOT_REGISTRATION,
    multi: true,
    inject: [PurchaseHotHook],
    useFactory: (hook: PurchaseHotHook): KindHotRegistration => ({ kind: 'purchase', hook }),
  } satisfies MultiFactoryProvider as unknown as Provider,
  // Class-S payer-members flush (plain HGETALL DomainFlushPlan path).
  {
    provide: EXTRA_DOMAIN_FLUSH_PLANS,
    multi: true,
    useValue: { domain: 'payer', plan: PAYER_MEMBERS_FLUSH_PLAN } satisfies ExtraDomainFlushPlan,
  } satisfies MultiValueProvider as unknown as Provider,
  // Class-N atomic-snapshot flushes (build gap 2): mon cells + rev day totals.
  {
    provide: EXTRA_CLASS_N_FLUSH_PLANS,
    multi: true,
    useValue: { domain: 'mon', plan: MON_CELL_FLUSH_PLAN } satisfies ExtraClassNFlushPlan,
  } satisfies MultiValueProvider as unknown as Provider,
  {
    provide: EXTRA_CLASS_N_FLUSH_PLANS,
    multi: true,
    useValue: { domain: 'rev', plan: REV_DAY_FLUSH_PLAN } satisfies ExtraClassNFlushPlan,
  } satisfies MultiValueProvider as unknown as Provider,
];

@Module({
  imports: [CommonModule, DatabaseModule, RedisModule, AppConfigModule, SecurityModule, WorkersModule],
  providers: [
    // Story services.
    PurchaseValidator,
    PurchaseDurableHook,
    PurchaseHotHook,
    PurchaseDedupGateService,
    FxService,
    MonetizationConfigService,
    CardinalityGuardService,
    MonetizationFloorProvider,
    MonetizationReadService,
    ReconciliationService,
    // SANCTIONED REBIND: the REAL durable purchase-dedup gate overrides 002's
    // Unimplemented placeholder (single-binding, last-wins; only 006 provides it).
    { provide: PURCHASE_DEDUP_GATE, useExisting: PurchaseDedupGateService },
    ...MONETIZATION_REGISTRATIONS,
  ],
  exports: [MonetizationReadService, MonetizationConfigService, ReconciliationService, FxService],
})
export class MonetizationModule {}
