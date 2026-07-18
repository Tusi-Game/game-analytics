/**
 * Default-deny PII scrubber (T-00.86, ops-envelope §9, spec §H-3).
 *
 * Accept-all props + an opt-in denylist means one careless `props.email` lands
 * in 90-day raw files AND the catalog before anyone notices. So v1 ships a
 * NON-EMPTY default `pii_prop_denylist` plus a value-pattern scrubber (email /
 * IP / phone regex), applied at ingest BEFORE the raw-append — i.e. inside the
 * worker's step 3, pre-step-4 (DARK-SPOT: no PII/no raw in Postgres; raw files
 * must not carry PII either).
 *
 * Two passes, both forward-only:
 *  - KEY denylist: any prop key matching the denylist (case-insensitive) is
 *    dropped entirely (key + value) and flagged;
 *  - VALUE scrubber: any surviving string value matching an email / IPv4 / long
 *    digit-run pattern is replaced with a `[redacted:<kind>]` marker and flagged.
 *
 * Returns a NEW props object (never mutates the input) plus whether anything was
 * scrubbed (the caller can surface a catalog PII-warning). The denylist is
 * per-game-overridable via `GAME.config.pii_prop_denylist`.
 */

import { Injectable } from '@nestjs/common';

/** The default denylist shipped in v1 (ops-envelope §9). Case-insensitive. */
export const DEFAULT_PII_DENYLIST = [
  'email',
  'e_mail',
  'ip',
  'ip_address',
  'phone',
  'phone_number',
  'name',
  'full_name',
  'first_name',
  'last_name',
  'address',
  'street',
  'ssn',
  'password',
  'credit_card',
] as const;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;
// A long digit run (≥ 9) catches phone numbers / card numbers without being so
// greedy it eats ordinary short numeric props.
const LONG_DIGITS_RE = /(?:\d[ -]?){9,}/;

export interface ScrubResult {
  /** A NEW props object with denylisted keys removed + values redacted. */
  props: Record<string, unknown>;
  /** True iff any key was dropped or any value redacted (PII-warning signal). */
  scrubbed: boolean;
  /** The denylisted keys that were dropped (for the catalog PII-warning). */
  droppedKeys: string[];
}

@Injectable()
export class PiiScrubService {
  /**
   * Scrub a props object BEFORE the raw append. `extraDenylist` merges the
   * per-game override onto the default (forward-only, never shrinks the default).
   */
  scrub(props: Record<string, unknown>, extraDenylist: readonly string[] = []): ScrubResult {
    const denySet = new Set<string>([...DEFAULT_PII_DENYLIST, ...extraDenylist].map((k) => k.toLowerCase()));
    const out: Record<string, unknown> = {};
    const droppedKeys: string[] = [];
    let scrubbed = false;

    for (const [key, value] of Object.entries(props)) {
      if (denySet.has(key.toLowerCase())) {
        droppedKeys.push(key);
        scrubbed = true;
        continue; // drop key + value entirely
      }
      const redacted = this.redactValue(value);
      if (redacted.changed) {
        scrubbed = true;
      }
      out[key] = redacted.value;
    }

    return { props: out, scrubbed, droppedKeys };
  }

  /** Redact a single value by pattern. Non-strings pass through unchanged. */
  private redactValue(value: unknown): { value: unknown; changed: boolean } {
    if (typeof value !== 'string') {
      return { value, changed: false };
    }
    if (EMAIL_RE.test(value)) {
      return { value: '[redacted:email]', changed: true };
    }
    if (IPV4_RE.test(value)) {
      return { value: '[redacted:ip]', changed: true };
    }
    if (LONG_DIGITS_RE.test(value)) {
      return { value: '[redacted:digits]', changed: true };
    }
    return { value, changed: false };
  }
}
