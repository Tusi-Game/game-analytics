/**
 * The 9-step op-order orchestrator (foundation §3.1) — runs the normative steps
 * in order for every dequeued record, threading the branded ordering tokens so
 * the invariant chain (raw-append ≺ seal ≺ dedup ≺ durable ≺ hot ≺ ack) is
 * enforced BY THE TYPE SYSTEM, not by convention.
 *
 * Steps 1,2,3,5,6 are the generic front-door logic 002 owns. Step 4 (raw
 * append) and step 9 (ack) are Unit-3 PORTS. Steps 7,8 are HOOKS whose bodies
 * later stories fill; 002 supplies the generic step-8 (cat/cnt/rank) and a no-op
 * step-7 for generic events (Q1: generic has no durable-immediate work).
 *
 * The front-door decision (steps 1–6) is stamped ONCE onto a {@link RoutedRecord}
 * that typed consumers read verbatim — they never re-derive dedup/seal/kind.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { EventEnvelope, EventKind } from '../../common/contracts/envelope';
import type { Disposition, FrontDoorVerdicts, RoutedRecord, SealState } from '../../common/contracts/queue-jobs';
import type { ExceptionReason } from '../../common/contracts/exception-reason';
import { correctSkew, SkewInput } from '../../common/kernel/skew';
import { checkSealState } from '../../common/kernel/seal';
import { eventBucketDay, fallbackBucketDay } from '../../common/kernel/logical-day';
import { WindowedDedupGate, PurchaseDedupGate, DedupOutcome, PURCHASE_DEDUP_GATE } from '../../common/kernel/dedup';
import { dropVerdict, quarantineVerdict, routeVerdict } from '../../common/kernel/disposition';
import { RAW_APPEND_PORT, ACK_PORT } from './unit3-ports';
import {
  AckPort,
  DedupPassedToken,
  DurableImmediateHook,
  HotUpdateHook,
  ParsedToken,
  RawAppendIntent,
  RawAppendPort,
  RoutedToken,
  SealCheckedToken,
  SkewCorrectedToken,
} from './pipeline-steps';

/** DI token for the step-3 name-cap gate (R3 other-overflow). */
export const NAME_CAP_GATE = 'NAME_CAP_GATE';
/** DI token for the step-3 typed-payload validator. */
export const TYPED_VALIDATOR = 'TYPED_VALIDATOR';
/** DI token for the step-7 durable-immediate hook. */
export const DURABLE_IMMEDIATE_HOOK = 'DURABLE_IMMEDIATE_HOOK';
/** DI token for the step-8 hot-update hook. */
export const HOT_UPDATE_HOOK = 'HOT_UPDATE_HOOK';
/** DI token for the step-3 PII scrub port (default-deny denylist + value scrubber). */
export const PII_SCRUB_PORT = 'PII_SCRUB_PORT';

/**
 * Step-3 PII scrub port (T-00.86, ops-envelope §9). Applied BEFORE the step-4
 * raw append so denylisted keys / PII-shaped values never land in a raw file or
 * the catalog (DARK-SPOT: no PII in raw/Postgres). Returns the scrubbed props to
 * substitute onto the envelope. A no-op default keeps the kernel runnable without
 * the security module.
 */
export interface PiiScrubPort {
  /** @returns scrubbed props to replace `envelope.props` with, pre-raw-append. */
  scrubProps(gameId: string, props: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Reserved event names that force the strict typed path regardless of declared kind (§H-2). */
export const RESERVED_NAME_KINDS: Readonly<Record<string, EventKind>> = {
  economy: 'economy',
  purchase: 'purchase',
  session: 'session',
};

/** The strict typed kinds (validated payloads). `generic` is permissive. */
export const TYPED_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(['economy', 'purchase', 'session']);

/** The literal overflow bucket name for over-cap distinct event names (R3). */
export const OTHER_OVERFLOW_NAME = 'other';

/** Per-record context the front door needs beyond the envelope. */
export interface KernelContext {
  /** Platform reporting offset in minutes (§4.7). */
  reportingOffsetMinutes: number;
  /** Wall-clock now (epoch ms) at evaluation — for the seal check. */
  now: number;
  /** Provenance derived server-side from the credential class (§4.5). */
  provenance: 'client' | 'server';
  /** The batch's BullMQ job id (carried into raw append for rebuild collapse). */
  batchJobId: string;
  /** Optional clock-sanity horizon override (hours). */
  clockSanityMaxHours?: number;
}

/**
 * A pluggable name-cap gate (§H-4). Returns the effective event name to bucket
 * under: the name itself if within cap / already known, or {@link
 * OTHER_OVERFLOW_NAME} once the per-game distinct-name budget is exhausted (R3
 * — KEPT + counted, never dropped). 002 supplies a Redis-set implementation in
 * Unit 3; the kernel only needs the decision.
 */
export interface NameCapGate {
  /** @returns the name to bucket under (may be `other`); never throws for over-cap. */
  resolveName(gameId: string, eventName: string): Promise<string>;
}

/**
 * Strict typed-payload validator (§3.1 step 3). Returns null if valid, or the
 * quarantine reason if invalid. Bodies for economy/purchase/session live in
 * their stories; the kernel only sequences the call. Generic events skip it.
 */
export interface TypedValidator {
  /** @returns null if the payload is valid for `kind`, else `quarantined_typed`. */
  validate(kind: EventKind, envelope: EventEnvelope): 'quarantined_typed' | null;
}

/** The step-1 parse result — what a valid parse yields, or a drop reason. */
type ParseOutcome = { ok: true; token: ParsedToken } | { ok: false; reason: Extract<ExceptionReason, 'nameless'> };

/** Full outcome of running one record through the pipeline. */
export interface PipelineOutcome {
  /** The routed record iff it reached at least step 3 (else undefined for early drops). */
  record?: RoutedRecord;
  /** The final front-door verdict. */
  verdicts: FrontDoorVerdicts;
  /** True iff step 8 hot updates ran (route + mutable + dedup-passed). */
  counted: boolean;
}

/**
 * The op-order kernel. Injectable so Unit 3 wires the concrete ports/hooks;
 * generic defaults keep 002 self-contained and testable.
 */
@Injectable()
export class IngestKernel {
  constructor(
    @Inject(RAW_APPEND_PORT) private readonly rawAppend: RawAppendPort,
    private readonly windowedDedup: WindowedDedupGate,
    @Inject(PURCHASE_DEDUP_GATE) private readonly purchaseDedup: PurchaseDedupGate,
    @Inject(NAME_CAP_GATE) private readonly nameCap: NameCapGate,
    @Inject(TYPED_VALIDATOR) private readonly typedValidator: TypedValidator,
    @Inject(DURABLE_IMMEDIATE_HOOK) private readonly durableHook: DurableImmediateHook,
    @Inject(HOT_UPDATE_HOOK) private readonly hotHook: HotUpdateHook,
    @Inject(ACK_PORT) private readonly ack: AckPort,
    @Inject(PII_SCRUB_PORT) private readonly piiScrub: PiiScrubPort,
  ) {}

  /**
   * Run one record through steps 1→9 in the normative order. Returns the front
   * door outcome. The token threading below is the enforcement: each step's
   * output token is the ONLY way to invoke the next step, so the order cannot be
   * transposed without a type error.
   */
  async process(rawEnvelope: EventEnvelope, ctx: KernelContext): Promise<PipelineOutcome> {
    // ---- Step 1: auth-scope + parse -------------------------------------
    const parsed = this.step1Parse(rawEnvelope);
    if (!parsed.ok) {
      // Nameless → DROP (never raw-appended). No routed record produced.
      return { verdicts: dropVerdict(parsed.reason), counted: false };
    }

    // ---- PII scrub (step 3 / pre-step-4, ops-envelope §9) ---------------
    // Default-deny denylist + value scrubber applied BEFORE any raw append so no
    // PII lands in a raw file or the catalog. The scrubbed props replace the
    // originals for the ENTIRE downstream pipeline (raw append, catalog, routed
    // record) — the raw envelope's props are never used past this point.
    const scrubbedProps = await this.piiScrub.scrubProps(rawEnvelope.game_id, rawEnvelope.props);
    const envelope: EventEnvelope = { ...rawEnvelope, props: scrubbedProps };

    // ---- Step 2: skew-correct -------------------------------------------
    const skew = this.step2Skew(envelope, ctx, parsed.token);
    const correctedTime = skew.result.correctedTime;
    // DARK-SPOT #4: normal events bucket on CORRECTED time; time_fallback events
    // bucket on SERVER-RECEIVED time. Two distinct functions, chosen here.
    const correctedDay = skew.result.timeFallback
      ? fallbackBucketDay(envelope.server_received_time, ctx.reportingOffsetMinutes)
      : eventBucketDay(correctedTime, ctx.reportingOffsetMinutes);

    // ---- Step 3: kind-route + reserved-name override + name-cap + validate
    const routed = await this.step3Route(envelope, skew.token);

    // Base routed record — the frozen handoff. Verdicts filled as we go.
    const makeRecord = (verdicts: FrontDoorVerdicts): RoutedRecord => ({
      envelope,
      resolved_kind: routed.resolvedKind,
      v: this.effectiveVersion(envelope),
      corrected_time: correctedTime,
      corrected_day: correctedDay,
      provenance: ctx.provenance,
      verdicts,
    });

    // unknown_kind → quarantine (raw-append then stop, feeds nothing).
    if (routed.quarantineReason === 'unknown_kind') {
      return this.quarantineAndStop(envelope, correctedDay, makeRecord, 'unknown_kind', ctx, routed.token);
    }
    // typed-invalid → quarantine (raw-append then stop).
    if (routed.quarantineReason === 'quarantined_typed') {
      return this.quarantineAndStop(envelope, correctedDay, makeRecord, 'quarantined_typed', ctx, routed.token);
    }

    // ---- Step 4: WRITE-AHEAD RAW APPEND (before any counter/seal/dedup) --
    // Accepted records append here; the token is required by everything after.
    const appended = await this.rawAppend.append(envelope, correctedDay, 'append', ctx.batchJobId);

    // ---- Step 5: seal check ---------------------------------------------
    const sealChecked = this.step5Seal(correctedTime, ctx, appended.token);
    if (sealChecked.state === 'sealed') {
      // Sealed-late → already raw-appended above; tally sealed_late on ARRIVAL
      // day, feed nothing, stop.
      const verdicts = quarantineVerdict('sealed_late', 'sealed');
      return { record: makeRecord(verdicts), verdicts, counted: false };
    }

    // ---- Step 6: dedup gate (two regimes, NEVER mixed) ------------------
    const dedup = await this.step6Dedup(envelope, routed.resolvedKind, sealChecked.token);
    if (dedup.outcome === 'duplicate') {
      const verdicts: FrontDoorVerdicts = {
        dedup_passed: false,
        seal_state: sealChecked.state,
        disposition: 'route',
      };
      return { record: makeRecord(verdicts), verdicts, counted: false };
    }

    // Accepted + deduped: this record ROUTES.
    const verdicts = routeVerdict(sealChecked.state, true);
    const record = makeRecord(verdicts);

    // ---- Step 7: durable-immediate (order: durable ≺ hot) ---------------
    const durable = await this.durableHook.write(record, sealChecked.token);

    // ---- Step 8: hot updates (requires dedup token + durable token) -----
    // routed.bucketName carries the §H-2/R3-resolved name (possibly `other`),
    // computed once in step 3, so the counter buckets under the correct name.
    const hot = await this.hotHook.update(record, routed.bucketName, dedup.token, durable);

    // ---- Step 9: ack (requires the hot token) ---------------------------
    await this.ack.ack(hot, ctx.batchJobId);

    return { record, verdicts, counted: true };
  }

  // ---- individual steps (generic 002 logic) -----------------------------

  /** Step 1: game scope comes from auth (ctx/provenance); parse guards name. */
  private step1Parse(envelope: EventEnvelope): ParseOutcome {
    // game_id is server-derived (auth), NEVER trusted from body — the caller has
    // already stamped envelope.game_id from the credential. Empty name is the
    // only nameless-drop the kernel guards here; unparseable-body drops happen at
    // the JSON boundary before the kernel is even called.
    if (typeof envelope.name !== 'string' || envelope.name.trim() === '') {
      return { ok: false, reason: 'nameless' };
    }
    return { ok: true, token: {} as ParsedToken };
  }

  /** Step 2: skew-correct + time_fallback flag. */
  private step2Skew(
    envelope: EventEnvelope,
    ctx: KernelContext,
    _parsed: ParsedToken,
  ): { result: ReturnType<typeof correctSkew>; token: SkewCorrectedToken } {
    const input: SkewInput = {
      clientEventTime: envelope.client_event_time,
      clientSentTime: envelope.client_sent_time,
      serverReceivedTime: envelope.server_received_time,
      clockSanityMaxHours: ctx.clockSanityMaxHours,
    };
    return { result: correctSkew(input), token: {} as SkewCorrectedToken };
  }

  /**
   * Step 3: reserved-name §H-2 override → typed strict validation → name-cap
   * other-overflow. Returns the resolved kind, the (possibly `other`) bucket
   * name, and any quarantine reason. Reserved names key on the RESOLVED kind.
   */
  private async step3Route(
    envelope: EventEnvelope,
    _skew: SkewCorrectedToken,
  ): Promise<{
    resolvedKind: EventKind;
    bucketName: string;
    quarantineReason?: Extract<ExceptionReason, 'unknown_kind' | 'quarantined_typed'>;
    token: RoutedToken;
  }> {
    const token = {} as RoutedToken;
    // §H-2: a reserved NAME forces its typed path regardless of declared kind.
    const overridden = RESERVED_NAME_KINDS[envelope.name];
    const resolvedKind: EventKind = overridden ?? envelope.kind;

    // Unrecognized kind (open enum, §1.1) that is neither generic nor a known
    // typed kind → quarantine unknown_kind (never coerced to generic).
    if (!overridden && resolvedKind !== 'generic' && !TYPED_KINDS.has(resolvedKind)) {
      return { resolvedKind, bucketName: envelope.name, quarantineReason: 'unknown_kind', token };
    }

    // Typed kinds → strict validation. Invalid → quarantined_typed (feeds nothing).
    if (TYPED_KINDS.has(resolvedKind)) {
      const invalid = this.typedValidator.validate(resolvedKind, envelope);
      if (invalid) {
        return { resolvedKind, bucketName: envelope.name, quarantineReason: invalid, token };
      }
    }

    // Name-cap gate (R3: over-cap distinct names collapse to `other`, KEPT +
    // counted — NOT dropped). Reserved/typed names are exempt from the cap.
    const bucketName = TYPED_KINDS.has(resolvedKind)
      ? envelope.name
      : await this.nameCap.resolveName(envelope.game_id, envelope.name);

    return { resolvedKind, bucketName, token };
  }

  /** Step 5: seal state of the corrected day (offset-shifted clock). */
  private step5Seal(
    correctedTime: number,
    ctx: KernelContext,
    _appended: import('./pipeline-steps').RawAppendedToken,
  ): { state: SealState; token: SealCheckedToken } {
    const state = checkSealState({
      correctedTime,
      now: ctx.now,
      reportingOffsetMinutes: ctx.reportingOffsetMinutes,
    });
    return { state, token: {} as SealCheckedToken };
  }

  /** Step 6: dedup — windowed for non-money, DURABLE for purchase (never mixed). */
  private async step6Dedup(
    envelope: EventEnvelope,
    resolvedKind: EventKind,
    _seal: SealCheckedToken,
  ): Promise<{ outcome: DedupOutcome; token: DedupPassedToken }> {
    let outcome: DedupOutcome;
    if (resolvedKind === 'purchase') {
      // Two purchase sub-contracts (006 refinement, design step 6):
      //  - SERVER revenue row → has transaction_id → the DURABLE gate ONLY (money
      //    NEVER uses the 24 h window; transaction_id is the durable-dedup key, R2).
      //  - CLIENT companion (zero-money context) → the client legitimately LACKS the
      //    store transaction_id (the join key is purchase_attempt_id, R2), so it
      //    passes ONLY 01's WINDOWED event_id gate and flows to the step-8 join.
      //    A companion carries no money, so a rare beyond-window replay cannot
      //    double-count revenue (it only re-enriches dims). purchase_attempt_id is
      //    NOT used for dedup — only for the step-8 join.
      const transactionId = this.readString(envelope.props, 'transaction_id');
      if (transactionId === null) {
        outcome = await this.windowedDedup.claim(envelope.game_id, envelope.event_id);
      } else {
        outcome = await this.purchaseDedup.claimTransaction(envelope.game_id, transactionId);
      }
    } else {
      // Windowed 24 h event_id marker for generic/economy/session.
      outcome = await this.windowedDedup.claim(envelope.game_id, envelope.event_id);
    }
    return { outcome, token: {} as DedupPassedToken };
  }

  /** Raw-append a quarantine-marked record then stop (feeds nothing). */
  private async quarantineAndStop(
    envelope: EventEnvelope,
    correctedDay: string,
    makeRecord: (v: FrontDoorVerdicts) => RoutedRecord,
    reason: Extract<ExceptionReason, 'unknown_kind' | 'quarantined_typed'>,
    ctx: KernelContext,
    _routed: RoutedToken,
  ): Promise<PipelineOutcome> {
    const intent: RawAppendIntent = 'append-quarantine';
    await this.rawAppend.append(envelope, correctedDay, intent, ctx.batchJobId);
    const verdicts = quarantineVerdict(reason);
    return { record: makeRecord(verdicts), verdicts, counted: false };
  }

  /** Effective wire version: absent on wire ⇒ 1 (§1.1). */
  private effectiveVersion(envelope: EventEnvelope): number {
    const v = (envelope as unknown as { v?: unknown }).v;
    return typeof v === 'number' && Number.isFinite(v) ? v : 1;
  }

  /** Read a string prop safely (no `any`). */
  private readString(props: Record<string, unknown>, key: string): string | null {
    const value = props[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  /** Expose the current disposition set for tests / consumers. */
  static dispositions(): readonly Disposition[] {
    return ['route', 'drop', 'quarantine'];
  }
}
