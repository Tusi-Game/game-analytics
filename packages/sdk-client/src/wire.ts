/**
 * Shared wire contract (client SDK view).
 *
 * The envelope + batch SHAPES are imported **type-only** from the platform's
 * canonical contracts (`src/common/contracts`) so there is exactly one physical
 * type definition on the whole platform — `import type` erases at compile time,
 * so this creates ZERO runtime dependency on NestJS (matches the `fixtures/`
 * precedent). The RUNTIME constants below (path, wire version, batch builder)
 * are owned by the SDK: a shipped, zero-dep browser bundle cannot reach into the
 * server's runtime, only its types.
 *
 * Foundation §1.1 (Q9 wire contract): POST /v1/events, `v:1` always emitted, a
 * mandatory `sdk {name, version}` descriptor, additive-only fields (free-form
 * context lives inside `props`, never as a new top-level field).
 */

// Type-only — compile-erased, zero runtime coupling to the server package.
import type { EventEnvelope, EventKind } from '../../../src/common/contracts/envelope';
import type { BatchRequest } from '../../../src/common/contracts/batch';

export type { EventEnvelope, EventKind, BatchRequest };

/**
 * The pinned ingest path (Q9). Appended to the caller's `endpoint`. Never
 * game-scoped — the game is server-derived from the credential class.
 */
export const EVENTS_PATH = '/v1/events';

/**
 * The wire protocol version. The SDK ALWAYS emits an explicit `v:1` even though
 * the server treats an absent `v` as 1 (Foundation §1.1). The wire stays `1`
 * additive-only forever; the package semver moves independently (Q9).
 */
export const WIRE_VERSION = 1 as const;

/**
 * The client SDK's stable wire identifier (`sdk.name`). Decoupled from the npm
 * scope: the package may be published as `@<org>/analytics-sdk`, but the wire
 * name the server correlates on is this stable string.
 */
export const SDK_NAME = 'analytics-sdk';

/**
 * The four `kind`s this SDK is allowed to emit. The open-enum / quarantine
 * machinery exists for FUTURE SDKs — this one never improvises a kind
 * (Foundation §1.1, §2.4 additive discipline).
 */
export const CLIENT_KINDS = ['generic', 'economy', 'purchase', 'session'] as const;

/**
 * The exact, closed set of top-level envelope keys permitted on the wire
 * (Foundation §1.1). The envelope factory is structurally forbidden from
 * emitting anything outside this set; everything else rides inside `props`.
 * `game_id` and `server_received_time` are DELIBERATELY EXCLUDED — the SDK never
 * sends them (server-derived), even though they exist on the canonical type.
 */
export const ALLOWED_ENVELOPE_KEYS = [
  'user_id',
  'anon_id',
  'session_id',
  'event_id',
  'name',
  'kind',
  'client_event_time',
  'client_sent_time',
  'props',
] as const;

/**
 * Build a wire batch body. The single place a batch object is assembled so the
 * `{ v:1, sdk, events }` shape and the additive-only discipline are enforced by
 * construction, not by review.
 *
 * `client_sent_time` is stamped by the transport at FLUSH (per attempt), not
 * here — this builder takes already-stamped events.
 */
export function buildBatch(events: EventEnvelope[], sdk: { name: string; version: string }): BatchRequest {
  return { v: WIRE_VERSION, sdk, events };
}
