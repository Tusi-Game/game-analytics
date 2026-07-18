/**
 * Collision-safe id minting for the server SDK (Foundation §4.1, spec §2.7).
 *
 * Node ≥ 20 always has `crypto.randomUUID` (Web Crypto is stable), so the server
 * path is simpler than the client's — but it still NEVER uses `Math.random`: a
 * false id collision on a trusted, money-adjacent event is unacceptable.
 * `event_id` is stamped on EVERY emission, purchases included.
 */

import { randomUUID } from 'node:crypto';

export function mintId(): string {
  return randomUUID();
}
