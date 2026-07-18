/**
 * The 9-step op-order kernel — step interfaces, typed ports, and the ordering
 * TOKENS that make the invariant chain enforceable (foundation §3.1).
 *
 * Invariant chain (normative):
 *   raw-append ≺ seal ≺ dedup ≺ durable-immediate ≺ hot-counter ≺ ack
 *
 * ENFORCEMENT — how counter-before-append is made STRUCTURALLY IMPOSSIBLE:
 * each stage produces a distinct branded token that the NEXT stage requires as
 * input, so the type system refuses any call sequence that skips or reorders a
 * stage. The hot-counter stage (step 8) demands a `DedupPassedToken`, which can
 * only be produced by the dedup stage (step 6), which in turn demands a
 * `RawAppendedToken` produced only by the raw-append stage (step 4). There is no
 * way to obtain a `DedupPassedToken` without first holding a `RawAppendedToken`,
 * so "count before append" does not type-check. The orchestrator threads the
 * tokens in order; a test asserts the miswiring is a compile error.
 */

import type { RoutedRecord } from '../../common/contracts/queue-jobs';
import type { EventEnvelope } from '../../common/contracts/envelope';

// ---------------------------------------------------------------------------
// Branded ordering tokens. The unique symbol brand makes each token
// unforgeable — only the stage that mints it can produce a value of its type.
// ---------------------------------------------------------------------------

declare const parsedBrand: unique symbol;
declare const skewBrand: unique symbol;
declare const routedBrand: unique symbol;
declare const rawAppendedBrand: unique symbol;
declare const sealCheckedBrand: unique symbol;
declare const dedupPassedBrand: unique symbol;
declare const durableBrand: unique symbol;
declare const hotBrand: unique symbol;

/** Step 1 output — body parsed, game scope resolved. */
export interface ParsedToken {
  readonly [parsedBrand]: true;
}
/** Step 2 output — skew corrected, corrected day computed. */
export interface SkewCorrectedToken {
  readonly [skewBrand]: true;
}
/** Step 3 output — kind resolved (post §H-2), validated, name-cap applied. */
export interface RoutedToken {
  readonly [routedBrand]: true;
}
/** Step 4 output — the full envelope has been write-ahead appended (or drop skips it). */
export interface RawAppendedToken {
  readonly [rawAppendedBrand]: true;
}
/** Step 5 output — seal state evaluated for the corrected day. */
export interface SealCheckedToken {
  readonly [sealCheckedBrand]: true;
}
/** Step 6 output — dedup claimed (or purchase durable-gated). Gate for hot writes. */
export interface DedupPassedToken {
  readonly [dedupPassedBrand]: true;
}
/** Step 7 output — durable-immediate absolutes written. */
export interface DurableWrittenToken {
  readonly [durableBrand]: true;
}
/** Step 8 output — hot counters updated. Gate for ack. */
export interface HotUpdatedToken {
  readonly [hotBrand]: true;
}

// ---------------------------------------------------------------------------
// Typed PORTS Unit 3 fills. Steps 4 and 9 are the front-door↔worker seams that
// 002 does not build (raw-file writer, queue ack); the kernel provides the
// interfaces and the orchestrator calls them in order.
// ---------------------------------------------------------------------------

/** Whether a record should be raw-appended (accepted OR quarantine-marked). */
export type RawAppendIntent = 'append' | 'append-quarantine' | 'skip-drop';

/**
 * Step 4 — WRITE-AHEAD RAW APPEND port (Unit 3 / 008 own the byte format).
 * The kernel calls `append()` BEFORE any counter/seal/dedup/hot write; the
 * returned {@link RawAppendedToken} is the proof-of-append that later stages
 * require. `skip-drop` records still return a token (they were never countable)
 * so the pipeline is uniform, but they carry `appended:false`.
 */
export interface RawAppendPort {
  /**
   * Append the full envelope to the game's corrected-day file, fsync'd, before
   * any counter. Duplicates ARE appended (dedup is next). Drops are NOT.
   * @returns a token proving the write-ahead step ran, plus whether bytes landed.
   */
  append(
    envelope: EventEnvelope,
    correctedDay: string,
    intent: RawAppendIntent,
    batchJobId: string,
  ): Promise<{ token: RawAppendedToken; appended: boolean }>;
}

/**
 * Step 9 — ACK port (Unit 3 owns BullMQ). Called only after step 8's
 * {@link HotUpdatedToken} exists, so ack can never precede the hot update.
 */
export interface AckPort {
  ack(token: HotUpdatedToken, batchJobId: string): Promise<void>;
}

/**
 * Step 7 — DURABLE-IMMEDIATE hook (bodies owned by 003/005/006). The kernel
 * guarantees ORDER (durable ≺ hot) and threads the token; the story supplies the
 * idempotent-absolute writes (first_seen, bitmap bit, money). A generic event
 * has NO durable-immediate work (Q1) — the default no-op just mints the token.
 */
export interface DurableImmediateHook {
  write(record: RoutedRecord, sealChecked: SealCheckedToken): Promise<DurableWrittenToken>;
}

/**
 * Step 8 — HOT-UPDATE hook. Requires a {@link DedupPassedToken} (so it cannot
 * run before dedup) and a {@link DurableWrittenToken} (so durable ≺ hot). 002's
 * generic implementation does cat-upsert + cnt HINCRBY + rank zincr via
 * rehydrate-on-miss; quarantined records feed NOTHING (the orchestrator never
 * reaches step 8 for them).
 *
 * `bucketName` is the RESOLVED name to count under — the §H-2/R3 name-cap gate is
 * consulted ONCE in step 3 and its result (the event name, or the literal
 * `other` overflow bucket for an over-cap distinct name) is threaded here so the
 * cap decision is authoritative and not re-derived.
 */
export interface HotUpdateHook {
  update(
    record: RoutedRecord,
    bucketName: string,
    dedup: DedupPassedToken,
    durable: DurableWrittenToken,
  ): Promise<HotUpdatedToken>;
}
