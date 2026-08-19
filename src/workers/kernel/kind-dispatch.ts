/**
 * Stage-C KIND-DISPATCH seam (shared substrate for 003-sessions, 004-economy,
 * 006-monetization).
 *
 * ============================ THE PROBLEM =================================
 * The kernel binds ONE {@link TypedValidator}, ONE {@link DurableImmediateHook},
 * and ONE {@link HotUpdateHook} (ingest-kernel.ts steps 3/7/8). Three typed
 * stories each need their OWN step-3 validation + step-7 durable + step-8 hot
 * body, chosen by `record.resolved_kind`. If every story tried to REPLACE the
 * single binding they would collide on workers.module.ts.
 *
 * ============================ THE SOLUTION ================================
 * Three DISPATCHERS fan out on the resolved kind to a per-kind registry, falling
 * back to the exact 002 default for any unregistered kind (so generic — and any
 * typed kind with no story wired yet — behaves EXACTLY as today; zero regression):
 *
 *   - {@link KindDispatchValidator}  → per-kind {@link TypedValidator},
 *                                      fallback {@link PermissiveTypedValidator}.
 *   - {@link KindDispatchDurableHook} → per-kind {@link DurableImmediateHook},
 *                                      fallback {@link NoopDurableImmediateHook}.
 *   - {@link KindDispatchHotHook}    → GENERIC base ALWAYS runs, THEN the routed
 *                                      story's accumulators (see composition
 *                                      contract below), fallback = generic only.
 *
 * The dispatchers implement the SAME interfaces the kernel already injects, so
 * they are drop-in: `workers.module.ts` rebinds TYPED_VALIDATOR /
 * DURABLE_IMMEDIATE_HOOK / HOT_UPDATE_HOOK to these three and NOTHING else in the
 * kernel changes. The branded ordering tokens flow through UNTOUCHED — the
 * durable dispatcher returns the story's {@link DurableWrittenToken} verbatim,
 * so `durable ≺ hot` stays compile-enforced.
 *
 * ============ REGISTRATION (additive / collision-free) ===================
 * A story does NOT edit the single kernel binding. It contributes registrations
 * through DI MULTI-PROVIDER tokens — {@link KIND_VALIDATOR_REGISTRATION},
 * {@link KIND_DURABLE_REGISTRATION}, {@link KIND_HOT_REGISTRATION}. Each story
 * module adds one `{ provide, multi: true, useFactory }` entry per triple; Nest
 * collects ALL entries across ALL modules into an array the dispatcher reads at
 * {@link OnModuleInit}. Adding a story is therefore PURELY ADDITIVE — two stories
 * can register two different kinds without a conflicting edit to the same line.
 *
 * ================== DISPOSITION / VERDICT RESPECT ========================
 * These hooks are only ever INVOKED by the orchestrator for records that reached
 * step 7/8 — i.e. routed, deduped, mutable-day records (the kernel stops earlier
 * for drop/quarantine/sealed/duplicate). The dispatchers do NOT re-check the
 * disposition; they inherit the kernel's guarantee that quarantined/dropped
 * records feed NOTHING (matches current behavior exactly). The step-3 validator
 * IS consulted for typed kinds and its `quarantined_typed` verdict still stops
 * the pipeline before step 4 — the dispatcher merely routes WHICH validator runs.
 */

import { Inject, Injectable, Optional, OnModuleInit } from '@nestjs/common';
import type { EventEnvelope, EventKind } from '../../common/contracts/envelope';
import type { RoutedRecord } from '../../common/contracts/queue-jobs';
import type { TypedValidator } from './ingest-kernel';
import type {
  DedupPassedToken,
  DurableImmediateHook,
  DurableWrittenToken,
  HotUpdatedToken,
  HotUpdateHook,
  SealCheckedToken,
} from './pipeline-steps';
import { GenericHotUpdateHook, NoopDurableImmediateHook, PermissiveTypedValidator } from './default-hooks';
import { StoryRegistry } from './story-registry';

// ---------------------------------------------------------------------------
// Registration record types + multi-provider DI tokens.
//
// A story provides ONE of these per (kind, impl) triple via a `multi: true`
// provider under the matching token. The dispatcher injects the whole array.
// ---------------------------------------------------------------------------

/** One story's step-3 typed-validator registration for a resolved kind. */
export interface KindValidatorRegistration {
  readonly kind: EventKind;
  readonly validator: TypedValidator;
}

/** One story's step-7 durable-immediate registration for a resolved kind. */
export interface KindDurableRegistration {
  readonly kind: EventKind;
  readonly hook: DurableImmediateHook;
}

/**
 * One story's step-8 hot-update registration for a resolved kind. The registered
 * hook supplies ONLY the story's accumulators — the generic cat/cnt/rank base is
 * run by the dispatcher itself, so a story never re-implements it (composition
 * contract below).
 */
export interface KindHotRegistration {
  readonly kind: EventKind;
  readonly hook: HotUpdateHook;
}

/** Multi-provider token: story step-3 validators. Inject as `KindValidatorRegistration[]`. */
export const KIND_VALIDATOR_REGISTRATION = 'KIND_VALIDATOR_REGISTRATION';
/** Multi-provider token: story step-7 durable hooks. Inject as `KindDurableRegistration[]`. */
export const KIND_DURABLE_REGISTRATION = 'KIND_DURABLE_REGISTRATION';
/** Multi-provider token: story step-8 hot hooks. Inject as `KindHotRegistration[]`. */
export const KIND_HOT_REGISTRATION = 'KIND_HOT_REGISTRATION';

// ---------------------------------------------------------------------------
// Shared registry helper — builds a Map<kind, impl> from a registration array,
// rejecting a double-registration of the same kind (a wiring bug the stories
// must not commit: two hooks fighting over one kind is exactly the collision the
// seam exists to prevent, so we fail loudly rather than silently drop one).
// ---------------------------------------------------------------------------

function buildRegistry<T>(
  label: string,
  registrations: readonly { readonly kind: EventKind }[],
  pick: (r: { readonly kind: EventKind }) => T,
): Map<EventKind, T> {
  const map = new Map<EventKind, T>();
  for (const reg of registrations) {
    if (map.has(reg.kind)) {
      throw new Error(
        `[kind-dispatch] duplicate ${label} registration for kind="${String(reg.kind)}": ` +
          `two modules registered the same kind. Each resolved kind may have at most one ${label}.`,
      );
    }
    map.set(reg.kind, pick(reg));
  }
  return map;
}

// ---------------------------------------------------------------------------
// 1. KindDispatchValidator — step 3.
// ---------------------------------------------------------------------------

/**
 * Step-3 typed validator that DISPATCHES by kind. Delegates to the story
 * validator registered for `kind`; falls back to {@link PermissiveTypedValidator}
 * for `generic` and any kind with no registered story (preserving today's
 * accept-everything behavior for the unregistered path — no regression).
 *
 * NOTE: the kernel only calls `validate()` for {@link TYPED_KINDS} (economy /
 * purchase / session) — generic skips it entirely (ingest-kernel.ts step 3). So
 * in practice the fallback fires only for a typed kind whose story is not yet
 * wired, keeping that typed kind permissive until its story lands (same as the
 * single PermissiveTypedValidator does today).
 */
@Injectable()
export class KindDispatchValidator implements TypedValidator, OnModuleInit {
  private readonly registry = new Map<EventKind, TypedValidator>();

  private sharedApplied = false;

  constructor(
    private readonly fallback: PermissiveTypedValidator,
    @Optional()
    @Inject(KIND_VALIDATOR_REGISTRATION)
    private readonly registrations: readonly KindValidatorRegistration[] = [],
    @Optional() private readonly shared?: StoryRegistry,
  ) {}

  onModuleInit(): void {
    const built = buildRegistry('validator', this.registrations, (r) => (r as KindValidatorRegistration).validator);
    for (const [kind, impl] of built) {
      this.registry.set(kind, impl);
    }
  }

  /** Fold the global {@link StoryRegistry} contributions in on first use (lazy so
   * the story modules — which init AFTER WorkersModule — have already registered). */
  private ensureShared(): void {
    if (this.sharedApplied || !this.shared) {
      return;
    }
    this.sharedApplied = true;
    for (const reg of this.shared.validators) {
      if (!this.registry.has(reg.kind)) {
        this.registry.set(reg.kind, reg.validator);
      }
    }
  }

  validate(kind: EventKind, envelope: EventEnvelope): 'quarantined_typed' | null {
    this.ensureShared();
    const impl = this.registry.get(kind) ?? this.fallback;
    return impl.validate(kind, envelope);
  }

  /** Observability/wiring check: the kinds this dispatcher will delegate. */
  registeredKinds(): EventKind[] {
    this.ensureShared();
    return [...this.registry.keys()];
  }
}

// ---------------------------------------------------------------------------
// 2. KindDispatchDurableHook — step 7.
// ---------------------------------------------------------------------------

/**
 * Step-7 durable-immediate hook that DISPATCHES by `record.resolved_kind`.
 * Delegates to the story hook registered for the kind; falls back to
 * {@link NoopDurableImmediateHook} for generic / unregistered kinds.
 *
 * ORDERING CONTRACT PRESERVED: `write()` returns the SAME
 * {@link DurableWrittenToken} the delegate minted (verbatim), which the kernel
 * threads into step 8. The dispatch wrapper adds no token of its own and never
 * fabricates one, so the compile-time `durable ≺ hot` guarantee is intact — the
 * hot step still cannot run without a real durable token.
 */
@Injectable()
export class KindDispatchDurableHook implements DurableImmediateHook, OnModuleInit {
  private readonly registry = new Map<EventKind, DurableImmediateHook>();

  private sharedApplied = false;

  constructor(
    private readonly fallback: NoopDurableImmediateHook,
    @Optional()
    @Inject(KIND_DURABLE_REGISTRATION)
    private readonly registrations: readonly KindDurableRegistration[] = [],
    @Optional() private readonly shared?: StoryRegistry,
  ) {}

  onModuleInit(): void {
    const built = buildRegistry('durable', this.registrations, (r) => (r as KindDurableRegistration).hook);
    for (const [kind, impl] of built) {
      this.registry.set(kind, impl);
    }
  }

  /** Fold the global {@link StoryRegistry} contributions in on first use (lazy). */
  private ensureShared(): void {
    if (this.sharedApplied || !this.shared) {
      return;
    }
    this.sharedApplied = true;
    for (const reg of this.shared.durables) {
      if (!this.registry.has(reg.kind)) {
        this.registry.set(reg.kind, reg.hook);
      }
    }
  }

  async write(record: RoutedRecord, sealChecked: SealCheckedToken): Promise<DurableWrittenToken> {
    this.ensureShared();
    const impl = this.registry.get(record.resolved_kind) ?? this.fallback;
    // Return the delegate's token verbatim — the ordering brand must survive.
    return impl.write(record, sealChecked);
  }

  /** Observability/wiring check: the kinds this dispatcher will delegate. */
  registeredKinds(): EventKind[] {
    this.ensureShared();
    return [...this.registry.keys()];
  }
}

// ---------------------------------------------------------------------------
// 3. KindDispatchHotHook — step 8 (with the composition contract).
// ---------------------------------------------------------------------------

/**
 * Step-8 hot-update hook that DISPATCHES by `record.resolved_kind`.
 *
 * ===================== HOT-HOOK COMPOSITION CONTRACT =====================
 * The generic cat/cnt/rank hot writes run for EVERY accepted kind (that is the
 * 002 step-8 base — every routed event shows up in the catalog, day-count, and
 * rank zset). A typed story then layers its OWN accumulators ON TOP. So the
 * contract is ADDITION, not REPLACEMENT:
 *
 *   for a routed record of resolved_kind K:
 *     1. ALWAYS run GenericHotUpdateHook.update(...)  ← base cat/cnt/rank
 *     2. IF a story hook is registered for K, run it  ← story accumulators only
 *
 * Consequences the three stories rely on:
 *   - A registered story hook implements ONLY its accumulators (eco/bal/sess/
 *     act/ret/mon/payer …). It MUST NOT redo cat/cnt/rank — the dispatcher has
 *     already done that. This keeps each story small and the generic invariants
 *     (catalog/day-count/rank) uniform across all kinds.
 *   - The generic base runs FIRST so the story's accumulators can assume the
 *     catalog/day-count for this event already reflect it if they read hot state.
 *   - The returned {@link HotUpdatedToken} is the base's token (the story hook's
 *     token is discarded) — a single ordering token for the whole step-8, so
 *     step-9 ack ordering is unchanged whether or not a story is registered.
 *
 * For an UNREGISTERED kind (generic, or any typed kind whose story is not yet
 * wired) the behavior is EXACTLY today's: run the generic base only. Zero
 * regression.
 *
 * Quarantined/dropped records never reach here (the orchestrator stops earlier),
 * so — as today — this hook only runs for routed, deduped, mutable-day records.
 */
@Injectable()
export class KindDispatchHotHook implements HotUpdateHook, OnModuleInit {
  private readonly registry = new Map<EventKind, HotUpdateHook>();

  private sharedApplied = false;

  constructor(
    private readonly base: GenericHotUpdateHook,
    @Optional()
    @Inject(KIND_HOT_REGISTRATION)
    private readonly registrations: readonly KindHotRegistration[] = [],
    @Optional() private readonly shared?: StoryRegistry,
  ) {}

  onModuleInit(): void {
    const built = buildRegistry('hot', this.registrations, (r) => (r as KindHotRegistration).hook);
    for (const [kind, impl] of built) {
      this.registry.set(kind, impl);
    }
  }

  /** Fold the global {@link StoryRegistry} contributions in on first use (lazy). */
  private ensureShared(): void {
    if (this.sharedApplied || !this.shared) {
      return;
    }
    this.sharedApplied = true;
    for (const reg of this.shared.hots) {
      if (!this.registry.has(reg.kind)) {
        this.registry.set(reg.kind, reg.hook);
      }
    }
  }

  async update(
    record: RoutedRecord,
    bucketName: string,
    dedup: DedupPassedToken,
    durable: DurableWrittenToken,
  ): Promise<HotUpdatedToken> {
    // (1) Generic base ALWAYS runs — cat/cnt/rank for every accepted kind. Its
    // token is the authoritative step-8 output threaded into ack.
    const baseToken = await this.base.update(record, bucketName, dedup, durable);

    // (2) Story accumulators run IN ADDITION, if a story is registered for the
    // resolved kind. It receives the SAME branded ordering tokens the kernel
    // threaded in (dedup + the real durable token) — NOT the base's hot token —
    // so the story hook is ordering-safe on its own terms and the durable ≺ hot
    // guarantee holds for the story body too. Its returned token is discarded:
    // the base token is the single step-8 ordering token threaded into ack.
    this.ensureShared();
    const story = this.registry.get(record.resolved_kind);
    if (story) {
      await story.update(record, bucketName, dedup, durable);
    }

    return baseToken;
  }

  /** Observability/wiring check: the kinds with a registered story accumulator. */
  registeredKinds(): EventKind[] {
    this.ensureShared();
    return [...this.registry.keys()];
  }
}
