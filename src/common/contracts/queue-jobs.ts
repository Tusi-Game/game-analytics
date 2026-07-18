import { EventEnvelope, EventKind } from './envelope';
import { ExceptionReason } from './exception-reason';

/**
 * Seal state of the record's corrected logical day at the moment the front door
 * evaluated it (foundation §4.3):
 * - `open`   — day is open, cells still mutable;
 * - `grace`  — within the 48 h post-`D_end` grace window, still mutable;
 * - `sealed` — day is sealed; the record is a late arrival, quarantined.
 */
export type SealState = 'open' | 'grace' | 'sealed';

/**
 * The front door's single disposition for a record — the ONE authoritative
 * decision consumers act on. Consumers (02/03/05) NEVER re-derive this:
 * - `route`      — accepted; hand to the typed consumer's step-7/8 body;
 * - `drop`       — refused before raw append (nameless/unparseable/rate-limited);
 * - `quarantine` — raw-appended with a marker but feeds NO counter/spine.
 */
export type Disposition = 'route' | 'drop' | 'quarantine';

/**
 * The front-door verdicts stamped once, at routing time, onto every record.
 * This is the whole front-door decision, frozen — a consumer reads these fields
 * verbatim and never recomputes dedup / seal / disposition (foundation §3.1).
 */
export interface FrontDoorVerdicts {
  /** True iff the record passed the dedup gate (step 6). */
  dedup_passed: boolean;
  /** Seal state of the corrected logical day (step 5). */
  seal_state: SealState;
  /** The authoritative disposition (route / drop / quarantine). */
  disposition: Disposition;
  /**
   * Present iff `disposition` is `drop` or `quarantine` — the tally reason that
   * explains the non-route (e.g. `quarantined_typed`, `sealed_late`,
   * `time_fallback`, `unknown_kind`, `unparseable`, `nameless`, `rate_limited`).
   */
  reason?: ExceptionReason;
}

/**
 * A single envelope after the front door has fully routed it (steps 1–6): the
 * complete, frozen handoff from the ingest producer (01) to the three typed
 * consumers (02/03/05). Reconciled to the R1 frozen contract — carries the full
 * envelope, the RESOLVED kind (post-§H-2 reserved-name override — distinct from
 * the wire `envelope.kind`), the stamped wire version, the corrected event-time
 * and logical day, and the front-door verdicts. Consumers read it verbatim and
 * never re-derive a front-door decision.
 */
export interface RoutedRecord {
  /** The full envelope, verbatim (unknown props preserved). */
  envelope: EventEnvelope;
  /**
   * The RESOLVED kind after the §H-2 reserved-name override — reserved names
   * (economy/purchase/session) route to their strict typed path regardless of
   * the declared `envelope.kind`. This, not `envelope.kind`, is authoritative
   * for routing.
   */
  resolved_kind: EventKind;
  /** Effective wire version stamped by the front door (absent on wire ⇒ 1). */
  v: number;
  /** Skew-corrected event time (epoch ms). */
  corrected_time: number;
  /** Corrected logical reporting day "YYYY-MM-DD" (reporting_offset applied). */
  corrected_day: string;
  /** Provenance derived server-side from the credential class (§4.5). */
  provenance: 'client' | 'server';
  /** The frozen front-door decision. */
  verdicts: FrontDoorVerdicts;
}

/**
 * BullMQ job payload enqueued by the ingest front door and consumed by workers.
 * Carries the OPAQUE batch — the front door does NO per-event work (P11): it
 * resolves `game_id` + `provenance` once from the credential class (never the
 * body — P12/P5, DARK-SPOT #9), stamps `game_id` onto each envelope, and enqueues.
 * The worker runs the kernel (steps 1→9) per event and produces the routed
 * records; the door never routes.
 */
export interface IngestBatchJob {
  /** Server-assigned batch id for tracing. */
  batch_id: string;
  /** Wire version stamped by the door (absent-on-wire ⇒ 1). */
  v: number;
  /** Provenance derived server-side from the credential class (§4.5). */
  provenance: 'client' | 'server';
  /**
   * The batch's canonical envelopes, each with `game_id` already stamped from the
   * authenticating credential (body `game_id` overwritten — trust boundary).
   */
  events: EventEnvelope[];
}

/**
 * BullMQ job payload of already-ROUTED records (post-front-door). Retained for
 * consumers that receive the frozen handoff directly; the 002 worker builds these
 * itself from an {@link IngestBatchJob}.
 */
export interface IngestJob {
  batch_id: string;
  routed_records: RoutedRecord[];
}
