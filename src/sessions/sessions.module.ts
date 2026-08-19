import { Module, type OnModuleInit, type Provider } from '@nestjs/common';
import { StoryRegistry } from '../workers/kernel/story-registry';
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
import { SessionValidator } from './session-validator';
import { SessionDurableHook } from './session-durable.hook';
import { SessionHotHook } from './session-hot.hook';
import { SpineRepository } from './spine.repository';
import { SessionFloorProvider } from './session-floor.provider';
import { SessionConfigService } from './session-config.service';
import { SessionReadService } from './session-read.service';
import { RetentionReadService } from './retention-read.service';
import { SpineRescanService } from './spine-rescan.service';
import { SESS_FLUSH_PLAN, ACT_FLUSH_PLAN, RET_COHORT_FLUSH_PLAN, RET_CELL_FLUSH_PLAN } from './session-flush-plans';

/**
 * Sessions + Retention (combined, [003-sessions] + [005-retention] per bridge
 * 02.5). ONE module: retention rides the session step-7 path (there is exactly one
 * spine-write site and it lives in the session worker).
 *
 * ============ Dispatcher registration (additive, collision-free) ============
 * Imports {@link WorkersModule} so the kind dispatchers + {@link FlushJobService}
 * are in scope, then contributes its per-kind triple + extra flush plans via the
 * seam's MULTI-PROVIDER tokens — NO conflicting edit to the single kernel binding:
 *   - KIND_VALIDATOR_REGISTRATION → { kind: 'session', validator: SessionValidator }
 *   - KIND_DURABLE_REGISTRATION   → { kind: 'session', hook: SessionDurableHook }   (7a/7b/7b′)
 *   - KIND_HOT_REGISTRATION       → { kind: 'session', hook: SessionHotHook }        (sess/act/ret ONLY)
 *   - EXTRA_DOMAIN_FLUSH_PLANS    → sess / act / ret plans (ret drains once, two plans)
 *
 * The hot hook implements ONLY the session accumulators — the dispatcher runs the
 * generic cat/cnt/rank base FIRST (composition contract). The durable hook returns
 * the kernel's branded DurableWrittenToken (carrying the step-7 state) so
 * durable ≺ hot stays enforced.
 *
 * Story-owned floor provider ({@link SessionFloorProvider}) is injected into the
 * hot hook directly — it never touches the generic FLOOR_PROVIDER (seam's
 * per-domain floor-extension pattern, collision-free by construction).
 */

/**
 * Local provider shapes that include `multi` — this @nestjs/common 10.x's exported
 * `FactoryProvider`/`ValueProvider` interfaces omit the (runtime-valid) `multi`
 * field, so we widen locally and assign into the `Provider[]` the decorator wants.
 */
type MultiFactoryProvider = {
  provide: string;
  multi: true;
  inject: unknown[];
  useFactory: (...args: never[]) => unknown;
};
type MultiValueProvider = { provide: string; multi: true; useValue: unknown };

/** The additive dispatcher registrations + extra flush plans. */
const SESSION_REGISTRATIONS: Provider[] = [
  {
    provide: KIND_VALIDATOR_REGISTRATION,
    multi: true,
    inject: [SessionValidator],
    useFactory: (validator: SessionValidator): KindValidatorRegistration => ({ kind: 'session', validator }),
  } satisfies MultiFactoryProvider as unknown as Provider,
  {
    provide: KIND_DURABLE_REGISTRATION,
    multi: true,
    inject: [SessionDurableHook],
    useFactory: (hook: SessionDurableHook): KindDurableRegistration => ({ kind: 'session', hook }),
  } satisfies MultiFactoryProvider as unknown as Provider,
  {
    provide: KIND_HOT_REGISTRATION,
    multi: true,
    inject: [SessionHotHook],
    useFactory: (hook: SessionHotHook): KindHotRegistration => ({ kind: 'session', hook }),
  } satisfies MultiFactoryProvider as unknown as Provider,
  // Extra flush plans — `ret` drains once and BOTH the cohort + cell plans run over
  // that single drained batch (mirrors 002's cnt/exc split on the `cnt` domain).
  {
    provide: EXTRA_DOMAIN_FLUSH_PLANS,
    multi: true,
    useValue: { domain: 'sess', plan: SESS_FLUSH_PLAN } satisfies ExtraDomainFlushPlan,
  } satisfies MultiValueProvider as unknown as Provider,
  {
    provide: EXTRA_DOMAIN_FLUSH_PLANS,
    multi: true,
    useValue: { domain: 'act', plan: ACT_FLUSH_PLAN } satisfies ExtraDomainFlushPlan,
  } satisfies MultiValueProvider as unknown as Provider,
  {
    provide: EXTRA_DOMAIN_FLUSH_PLANS,
    multi: true,
    useValue: { domain: 'ret', plan: RET_COHORT_FLUSH_PLAN } satisfies ExtraDomainFlushPlan,
  } satisfies MultiValueProvider as unknown as Provider,
  {
    provide: EXTRA_DOMAIN_FLUSH_PLANS,
    multi: true,
    useValue: { domain: 'ret', plan: RET_CELL_FLUSH_PLAN } satisfies ExtraDomainFlushPlan,
  } satisfies MultiValueProvider as unknown as Provider,
];

@Module({
  imports: [CommonModule, DatabaseModule, RedisModule, AppConfigModule, WorkersModule],
  providers: [
    // Story services.
    SessionValidator,
    SessionDurableHook,
    SessionHotHook,
    SpineRepository,
    SessionFloorProvider,
    SessionConfigService,
    SessionReadService,
    RetentionReadService,
    SpineRescanService,
    ...SESSION_REGISTRATIONS,
  ],
  exports: [SessionConfigService, SessionReadService, RetentionReadService, SpineRescanService, SpineRepository],
})
export class SessionsModule implements OnModuleInit {
  constructor(
    private readonly registry: StoryRegistry,
    private readonly validator: SessionValidator,
    private readonly durable: SessionDurableHook,
    private readonly hot: SessionHotHook,
  ) {}

  /**
   * Push the `session` triple + sess/act/ret flush plans into the global
   * {@link StoryRegistry}. Runs AFTER WorkersModule init (this module imports it),
   * so the dispatchers/flush — which read the registry lazily on first use — pick
   * these up. The legacy KIND_*_REGISTRATION / EXTRA_DOMAIN_FLUSH_PLANS providers
   * above stay (harmless) but no longer reach the WorkersModule-scoped consumers.
   */
  onModuleInit(): void {
    this.registry.registerValidator({ kind: 'session', validator: this.validator });
    this.registry.registerDurable({ kind: 'session', hook: this.durable });
    this.registry.registerHot({ kind: 'session', hook: this.hot });
    this.registry.registerFlushPlan({ domain: 'sess', plan: SESS_FLUSH_PLAN });
    this.registry.registerFlushPlan({ domain: 'act', plan: ACT_FLUSH_PLAN });
    this.registry.registerFlushPlan({ domain: 'ret', plan: RET_COHORT_FLUSH_PLAN });
    this.registry.registerFlushPlan({ domain: 'ret', plan: RET_CELL_FLUSH_PLAN });
  }
}
