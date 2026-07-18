/**
 * @<org>/analytics-sdk — the browser / game client SDK (spec 009-client-sdk).
 *
 * The shipped, spoofable, zero-money path: it turns game-code calls into
 * canonical envelopes, survives flaky networks and killed tabs, and executes the
 * [003-sessions §1] session definition. Public `sdk_key` (pk_) auth; every event
 * is server-stamped `provenance=client`.
 *
 * Quickstart:
 *   const sdk = await AnalyticsClient.init({ sdkKey: 'pk_...', endpoint: 'https://analytics.example.com' });
 *   await sdk.track('level_start', { level: 1 });
 */

export { AnalyticsClient } from './client';
export type { ClientConfigInput, StorageMode, CompressMode } from './config';
export type { PurchaseContextInput, EconomyContext, ClientTestHooks } from './client';
export type { FlowType } from './validation';
export { LocalValidationError } from './validation';
export { SDK_VERSION } from './version';
export { WIRE_VERSION, SDK_NAME, EVENTS_PATH } from './wire';
export type { EventEnvelope, EventKind, BatchRequest } from './wire';
