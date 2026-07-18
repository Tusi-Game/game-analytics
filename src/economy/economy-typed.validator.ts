/**
 * Step-3 strict `economy` payload validator ([004-economy] design step 3, spec §6,
 * T-03.13). Registered with the kind dispatcher for `kind = economy`.
 *
 * SHAPE-ONLY (Foundation §4.4), synchronous by the {@link TypedValidator}
 * contract: a missing/malformed REQUIRED field → quarantine (`quarantined_typed`,
 * raw-appended-with-marker, feeds nothing). An economy event is VALID iff:
 *   - `flow_type`     is exactly `source` or `sink` (nothing else);
 *   - `currency_type` is a non-empty string;
 *   - `amount`        is a finite number strictly `> 0` — direction is carried by
 *                     `flow_type`, NEVER by sign; a NEGATIVE/zero amount is
 *                     malformed and quarantines (it is NOT auto-flipped);
 *   - `reason`        is a non-empty string.
 *
 * Deliberately NOT enforced here (they need async config/Redis the sync validator
 * cannot reach — handled in the step-8 hot hook, T-03.45 reconciliation):
 *   - `economy_currency_allowlist` (async GameConfig read) → hot hook skips a
 *     disallowed currency + tallies (forward-only config gate);
 *   - currency observed-value cap / `other` overflow (async Redis EVAL) → hot hook
 *     resolves currency to itself-or-`other` before counting (R3: kept, never
 *     dropped).
 *
 * Optional fields fail FIELD-level, never event-level (design "Optional fields fail
 * field-level"): `balance_after` non-numeric or `< 0` ⇒ the depth field is
 * discarded (the event still accumulates its flow); absent player context ⇒ that
 * segment axis is simply skipped. So they are NOT checked here.
 */

import { Injectable } from '@nestjs/common';
import type { EventEnvelope, EventKind } from '../common/contracts/envelope';
import type { TypedValidator } from '../workers/kernel/ingest-kernel';

/** The two valid flow directions (nothing else is accepted). */
export const FLOW_TYPES = ['source', 'sink'] as const;
export type EconomyFlowType = (typeof FLOW_TYPES)[number];
const FLOW_TYPE_SET: ReadonlySet<string> = new Set(FLOW_TYPES);

/** Read + normalize `flow_type` from props (exact `source`/`sink` or null). */
export function readFlowType(props: Record<string, unknown>): EconomyFlowType | null {
  const raw = props['flow_type'];
  return typeof raw === 'string' && FLOW_TYPE_SET.has(raw) ? (raw as EconomyFlowType) : null;
}

/** Read `currency_type` (non-empty string) from props, or null. */
export function readCurrencyType(props: Record<string, unknown>): string | null {
  const raw = props['currency_type'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Read `reason` (non-empty string) from props, or null. */
export function readReason(props: Record<string, unknown>): string | null {
  const raw = props['reason'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Read a strictly-positive finite `amount` (magnitude only), or null when the
 * field is absent/non-numeric/zero/negative. Direction is `flow_type`'s — a
 * negative is malformed, NEVER flipped.
 */
export function readAmount(props: Record<string, unknown>): number | null {
  const raw = props['amount'];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return raw;
}

/**
 * Read the optional `balance_after` (numeric ≥ 0), or null to DISCARD the field
 * (never quarantines the event; not clamped to zero). An implausible negative is
 * clamped out of depth by returning null here.
 */
export function readBalanceAfter(props: Record<string, unknown>): number | null {
  const raw = props['balance_after'];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    return null;
  }
  return raw;
}

@Injectable()
export class EconomyTypedValidator implements TypedValidator {
  validate(kind: EventKind, envelope: EventEnvelope): 'quarantined_typed' | null {
    // The dispatcher only routes `economy` here; guard defensively so a stray call
    // for another kind is a permissive no-op (never a false quarantine).
    if (kind !== 'economy') {
      return null;
    }
    const props = envelope.props;

    if (readFlowType(props) === null) {
      return 'quarantined_typed';
    }
    if (readCurrencyType(props) === null) {
      return 'quarantined_typed';
    }
    if (readAmount(props) === null) {
      return 'quarantined_typed';
    }
    if (readReason(props) === null) {
      return 'quarantined_typed';
    }
    return null;
  }
}
