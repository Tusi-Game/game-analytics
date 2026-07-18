/**
 * @<org>/analytics-sdk-server — the Node server SDK (spec 010-server-sdk).
 *
 * The TRUSTED emitter: verified purchase rows (money truth) + server-granted
 * economy flows. Secret `server_credential` (sk_) auth; every event is
 * server-stamped `provenance=server` — the only events eligible for revenue.
 * NEVER emits `kind=session` (activeness is client-anchored, R11).
 *
 * Quickstart:
 *   const sdk = AnalyticsServer.init({
 *     serverCredential: process.env.ANALYTICS_SERVER_CREDENTIAL!,
 *     endpoint: 'https://analytics.example.com',
 *   });
 *   // after your OWN receipt validation:
 *   sdk.verifiedPurchase({ ...outcome });
 */

export { AnalyticsServer } from './server';
export type { VerifiedPurchaseInput, EconomyInput, TrackOptions } from './server';
export type { ServerConfigInput, OnError } from './config';
export { QueueOverflowError } from './queue';
export type { FlowType } from './wire-kinds';
export { SDK_VERSION } from './version';
export { WIRE_VERSION, SDK_NAME, EVENTS_PATH } from './wire';
export type { EventEnvelope, EventKind, BatchRequest } from './wire';
