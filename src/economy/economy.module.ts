import { Module, type Provider } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { DatabaseModule } from '../database/database.module';
import { RedisModule } from '../redis/redis.module';
import { AppConfigModule } from '../config/app-config.module';
import { WorkersModule } from '../workers/workers.module';
import {
  KIND_VALIDATOR_REGISTRATION,
  KIND_DURABLE_REGISTRATION,
  KIND_HOT_REGISTRATION,
  type KindValidatorRegistration,
  type KindDurableRegistration,
  type KindHotRegistration,
} from '../workers/kernel/kind-dispatch';
import { EXTRA_DOMAIN_FLUSH_PLANS, type ExtraDomainFlushPlan } from '../workers/flush/flush-job.service';
import { NoopDurableImmediateHook } from '../workers/kernel/default-hooks';
import { EconomyTypedValidator } from './economy-typed.validator';
import { EconomyHotUpdateHook } from './economy-hot-update.hook';
import { EcoCurrencyCapGate } from './eco-currency-cap.gate';
import { EconomyFloorProvider } from './economy-floor.provider';
import { BalanceLwwService } from './balance-lww.service';
import { EconomyConfigService } from './economy-config.service';
import { EconomyReadService } from './economy-read.service';
import { EconomySupplySnapshotService } from './economy-supply-snapshot.service';
import { ECO_BASE_FLUSH_PLAN, ECO_SEGMENT_FLUSH_PLAN, BAL_FLUSH_PLAN } from './economy-flush-plans';

/**
 * Economy (Sink / Source) — [004-economy]. Registers the `economy` kind's
 * step-3/7/8 triple + the eco/bal flush plans with the shared kind-dispatch seam
 * ADDITIVELY (no conflicting edit to the single kernel binding).
 *
 * ============ Dispatcher registration (additive, collision-free) ============
 * Imports {@link WorkersModule} so the kind dispatchers + {@link FlushJobService}
 * are in scope, then contributes via the seam's MULTI-PROVIDER tokens:
 *   - KIND_VALIDATOR_REGISTRATION → { kind: 'economy', validator: EconomyTypedValidator }
 *   - KIND_DURABLE_REGISTRATION   → { kind: 'economy', hook: Noop } (economy owns NO
 *                                    step-7 durable write — it is not money; balance
 *                                    rides the class-L FLUSH, not step 7)
 *   - KIND_HOT_REGISTRATION       → { kind: 'economy', hook: EconomyHotUpdateHook }
 *                                    (eco / eco:seg / bal accumulators ONLY — the
 *                                    dispatcher runs the generic cat/cnt/rank base FIRST)
 *   - EXTRA_DOMAIN_FLUSH_PLANS    → eco (base + :seg, class M) + bal (class L)
 *
 * The story-owned floor provider ({@link EconomyFloorProvider}) is injected into
 * the hot hook + balance-lww directly — it NEVER touches the generic FLOOR_PROVIDER
 * (seam's per-domain floor-extension pattern, collision-free by construction).
 */

/** Local provider shapes widened to include `multi` (see sessions.module.ts). */
type MultiFactoryProvider = {
  provide: string;
  multi: true;
  inject: unknown[];
  useFactory: (...args: never[]) => unknown;
};
type MultiValueProvider = { provide: string; multi: true; useValue: unknown };

/** The additive dispatcher registrations + extra flush plans. */
const ECONOMY_REGISTRATIONS: Provider[] = [
  {
    provide: KIND_VALIDATOR_REGISTRATION,
    multi: true,
    inject: [EconomyTypedValidator],
    useFactory: (validator: EconomyTypedValidator): KindValidatorRegistration => ({ kind: 'economy', validator }),
  } satisfies MultiFactoryProvider as unknown as Provider,
  {
    // Economy has NO step-7 durable write — bind the shared Noop for the kind so
    // the durable dispatcher returns a real (empty) DurableWrittenToken and
    // durable ≺ hot stays compile-enforced.
    provide: KIND_DURABLE_REGISTRATION,
    multi: true,
    inject: [NoopDurableImmediateHook],
    useFactory: (hook: NoopDurableImmediateHook): KindDurableRegistration => ({ kind: 'economy', hook }),
  } satisfies MultiFactoryProvider as unknown as Provider,
  {
    provide: KIND_HOT_REGISTRATION,
    multi: true,
    inject: [EconomyHotUpdateHook],
    useFactory: (hook: EconomyHotUpdateHook): KindHotRegistration => ({ kind: 'economy', hook }),
  } satisfies MultiFactoryProvider as unknown as Provider,
  // Extra flush plans — the `eco` domain holds BOTH base + :seg keys (drains once,
  // both plans run over that batch, each skipping the shape it does not own);
  // `bal` is the class-L balance flush.
  {
    provide: EXTRA_DOMAIN_FLUSH_PLANS,
    multi: true,
    useValue: { domain: 'eco', plan: ECO_BASE_FLUSH_PLAN } satisfies ExtraDomainFlushPlan,
  } satisfies MultiValueProvider as unknown as Provider,
  {
    provide: EXTRA_DOMAIN_FLUSH_PLANS,
    multi: true,
    useValue: { domain: 'eco', plan: ECO_SEGMENT_FLUSH_PLAN } satisfies ExtraDomainFlushPlan,
  } satisfies MultiValueProvider as unknown as Provider,
  {
    provide: EXTRA_DOMAIN_FLUSH_PLANS,
    multi: true,
    useValue: { domain: 'bal', plan: BAL_FLUSH_PLAN } satisfies ExtraDomainFlushPlan,
  } satisfies MultiValueProvider as unknown as Provider,
];

@Module({
  imports: [CommonModule, DatabaseModule, RedisModule, AppConfigModule, WorkersModule],
  providers: [
    // Story services.
    EconomyTypedValidator,
    EconomyHotUpdateHook,
    EcoCurrencyCapGate,
    EconomyFloorProvider,
    BalanceLwwService,
    EconomyConfigService,
    EconomyReadService,
    EconomySupplySnapshotService,
    // Local Noop durable hook for the `economy` kind (economy owns NO step-7
    // durable write). Provided HERE (not injected from WorkersModule) so the
    // KIND_DURABLE_REGISTRATION factory resolves it in this module's context.
    NoopDurableImmediateHook,
    ...ECONOMY_REGISTRATIONS,
  ],
  exports: [EconomyReadService, EconomySupplySnapshotService, EconomyConfigService],
})
export class EconomyModule {}
