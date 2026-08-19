/**
 * Cross-module story registry (fixes the [kind-dispatch] wiring break).
 *
 * ============================ THE PROBLEM =================================
 * The step-3/7/8 dispatchers ({@link KindDispatchValidator} etc.) and the flush
 * orchestrator ({@link FlushJobService}) live in {@link WorkersModule}, and each
 * collects its per-kind / per-domain contributions through an `@Optional()
 * @Inject(TOKEN)` multi-provider array. But those contributions are provided by
 * the STORY modules (003-sessions / 004-economy / 006-monetization), which IMPORT
 * WorkersModule — not the reverse. NestJS resolves a multi-provider array in the
 * CONSUMER's module scope, so the WorkersModule-owned consumers only ever saw the
 * `@Optional` empty-array DEFAULT: every story validate/durable/hot hook and every
 * story flush plan was silently dropped. Only the generic cat/cnt/rank base ran —
 * sessions, economy and monetization NEVER computed in the assembled app.
 *
 * ============================ THE FIX ====================================
 * A single `@Global()` registry both sides can reach the SAME instance of: the
 * story modules PUSH their registrations into it at their own `onModuleInit`
 * (which runs AFTER WorkersModule's, since they import it), and the consumers READ
 * it LAZILY on first dispatch/sweep (well after all module init). Being global,
 * the consumer sees it without WorkersModule importing the story modules (which
 * would be a cycle). The legacy `@Optional() @Inject(TOKEN)` arrays are still
 * honored and merged first, so the hand-wired unit specs are unaffected.
 */

import { Global, Injectable, Module } from '@nestjs/common';
import type { KindValidatorRegistration, KindDurableRegistration, KindHotRegistration } from './kind-dispatch';
import type { ExtraDomainFlushPlan, ExtraClassNFlushPlan } from '../flush/flush-job.service';

/** The mutable app-wide registry story modules populate and consumers read. */
@Injectable()
export class StoryRegistry {
  readonly validators: KindValidatorRegistration[] = [];
  readonly durables: KindDurableRegistration[] = [];
  readonly hots: KindHotRegistration[] = [];
  readonly flushPlans: ExtraDomainFlushPlan[] = [];
  readonly classNFlushPlans: ExtraClassNFlushPlan[] = [];

  registerValidator(reg: KindValidatorRegistration): void {
    this.validators.push(reg);
  }
  registerDurable(reg: KindDurableRegistration): void {
    this.durables.push(reg);
  }
  registerHot(reg: KindHotRegistration): void {
    this.hots.push(reg);
  }
  registerFlushPlan(plan: ExtraDomainFlushPlan): void {
    this.flushPlans.push(plan);
  }
  registerClassNFlushPlan(plan: ExtraClassNFlushPlan): void {
    this.classNFlushPlans.push(plan);
  }
}

/**
 * Global module so the ONE {@link StoryRegistry} instance is injectable everywhere
 * — by the WorkersModule-owned consumers AND by the story modules — with no import
 * cycle. Imported once by the root module.
 */
@Global()
@Module({
  providers: [StoryRegistry],
  exports: [StoryRegistry],
})
export class StoryRegistryModule {}
