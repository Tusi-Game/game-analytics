/**
 * Step-3 strict `purchase` payload validator ([006-monetization] design step 3, T).
 * Registered with the kind dispatcher for `kind = purchase`.
 *
 * The reserved name always routes strict, even malformed. `source` selects the
 * SUB-CONTRACT (NOT the trust — trust derives from the credential CLASS,
 * record.provenance, never the body; §4.5 / P5):
 *   - `source=server` (revenue row): required — transaction_id, original_transaction_id,
 *     product_id, product_category, price_local (finite number), currency, verified
 *     (boolean), environment (`prod`|`sandbox`), user_id. Any missing/type-invalid →
 *     quarantine (`quarantined_typed`).
 *   - `source=client` (companion): required — purchase_attempt_id ONLY (the SDK-minted
 *     join key; the client often lacks the store transaction_id at context time).
 *     Money-shaped fields on a companion are IGNORED, never summed (zero-money invariant).
 *   - `source` missing/invalid → quarantine (the trust-boundary field cannot default).
 *
 * SHAPE-ONLY + SYNC (the {@link TypedValidator} contract). Eligibility (6a:
 * verified ∧ prod ∧ server-provenance) and the FX/dimension/cardinality resolution are
 * NOT here (they need the credential class + async config/Redis) — handled at step 6/7/8.
 */

import { Injectable } from '@nestjs/common';
import type { EventEnvelope, EventKind } from '../common/contracts/envelope';
import type { TypedValidator } from '../workers/kernel/ingest-kernel';

/** The two valid purchase sub-contract sources (nothing else). */
export const PURCHASE_SOURCES = ['server', 'client'] as const;
export type PurchaseSource = (typeof PURCHASE_SOURCES)[number];
const SOURCE_SET: ReadonlySet<string> = new Set(PURCHASE_SOURCES);

/** Valid `environment` values. */
export const PURCHASE_ENVIRONMENTS = ['prod', 'sandbox'] as const;
const ENV_SET: ReadonlySet<string> = new Set(PURCHASE_ENVIRONMENTS);

/** Read the sub-contract `source` (`server`|`client`), or null if absent/invalid. */
export function readSource(props: Record<string, unknown>): PurchaseSource | null {
  const raw = props['source'];
  return typeof raw === 'string' && SOURCE_SET.has(raw) ? (raw as PurchaseSource) : null;
}

/** Read a required non-empty string prop, or null. */
export function readRequiredString(props: Record<string, unknown>, key: string): string | null {
  const raw = props[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Read a finite numeric prop (any sign), or null. Money magnitude — checked ≥ 0 by 6a not here. */
export function readNumber(props: Record<string, unknown>, key: string): number | null {
  const raw = props[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** Read a required boolean prop, or null. */
export function readBoolean(props: Record<string, unknown>, key: string): boolean | null {
  const raw = props[key];
  return typeof raw === 'boolean' ? raw : null;
}

/** Read `environment` (`prod`|`sandbox`), or null. */
export function readEnvironment(props: Record<string, unknown>): 'prod' | 'sandbox' | null {
  const raw = props['environment'];
  return typeof raw === 'string' && ENV_SET.has(raw) ? (raw as 'prod' | 'sandbox') : null;
}

/** Read the optional `refunded` flag (default false; never quarantines). */
export function readRefunded(props: Record<string, unknown>): boolean {
  return props['refunded'] === true;
}

@Injectable()
export class PurchaseValidator implements TypedValidator {
  validate(kind: EventKind, envelope: EventEnvelope): 'quarantined_typed' | null {
    // The dispatcher only routes `purchase` here; guard defensively.
    if (kind !== 'purchase') {
      return null;
    }
    const props = envelope.props;

    const source = readSource(props);
    if (source === null) {
      return 'quarantined_typed';
    }

    if (source === 'server') {
      // Server revenue row — the full required set.
      if (readRequiredString(props, 'transaction_id') === null) {
        return 'quarantined_typed';
      }
      if (readRequiredString(props, 'original_transaction_id') === null) {
        return 'quarantined_typed';
      }
      if (readRequiredString(props, 'product_id') === null) {
        return 'quarantined_typed';
      }
      if (readRequiredString(props, 'product_category') === null) {
        return 'quarantined_typed';
      }
      if (readNumber(props, 'price_local') === null) {
        return 'quarantined_typed';
      }
      if (readRequiredString(props, 'currency') === null) {
        return 'quarantined_typed';
      }
      if (readBoolean(props, 'verified') === null) {
        return 'quarantined_typed';
      }
      if (readEnvironment(props) === null) {
        return 'quarantined_typed';
      }
      if (
        readRequiredString(props, 'user_id') === null &&
        (typeof envelope.user_id !== 'string' || envelope.user_id.length === 0)
      ) {
        return 'quarantined_typed';
      }
      return null;
    }

    // source === 'client' — companion; ONLY the join key is required. Money-shaped
    // fields are ignored downstream (never validated, never summed).
    if (readRequiredString(props, 'purchase_attempt_id') === null) {
      return 'quarantined_typed';
    }
    return null;
  }
}
