import type { Request } from 'express';

/**
 * The provenance of an ingested request — whether it came from an untrusted
 * browser client SDK or a trusted server-side SDK.
 */
export type Provenance = 'client' | 'server';

/**
 * Express request augmented by the SDK-key guard.
 *
 * The guard resolves the SDK key to a `game_id` (never trusted from the body)
 * and a `provenance`, then attaches them here so downstream handlers and the
 * `@GameId()` / `@Provenance()` decorators can read them in a typed way.
 */
export interface AuthenticatedRequest extends Request {
  game_id?: string;
  provenance?: Provenance;
}
