/**
 * Shared wire contract (server SDK view). Same discipline as the client:
 * envelope/batch SHAPES are `import type`d from the platform contracts
 * (compile-erased, zero runtime coupling); the RUNTIME constants + batch builder
 * are owned here. Foundation §1.1 (Q9).
 *
 * The wire identifier `sdk.name = "analytics-sdk-server"` is STABLE regardless of
 * the npm scope (spec §2.6) — it is what lets the platform correlate a shipped
 * server-SDK release with its behavior years later.
 */

import type { EventEnvelope, EventKind } from '../../../src/common/contracts/envelope';
import type { BatchRequest } from '../../../src/common/contracts/batch';

export type { EventEnvelope, EventKind, BatchRequest };

export const EVENTS_PATH = '/v1/events';
export const WIRE_VERSION = 1 as const;

/** The stable wire `sdk.name` for the server SDK (decoupled from npm scope). */
export const SDK_NAME = 'analytics-sdk-server';

/**
 * The three `kind`s the server SDK is allowed to emit. It NEVER emits
 * `kind=session` (R11 — activeness is client-session-anchored, Foundation §7).
 */
export const SERVER_KINDS = ['purchase', 'economy', 'generic'] as const;

export function buildBatch(events: EventEnvelope[], sdk: { name: string; version: string }): BatchRequest {
  return { v: WIRE_VERSION, sdk, events };
}
