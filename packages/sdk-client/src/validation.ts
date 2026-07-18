/**
 * Call-site local validation (spec §3.3). The SDK validates ONLY what would be
 * unconditionally lost or unusable server-side — empty `name`, non-positive
 * `amount` / invalid `flow_type` on economy — so a conforming SDK never
 * originates a drop-class event (bridge 01.5). Everything else ships as given;
 * strict validation is the server's job (Foundation §3.1 step 3), never
 * duplicated here.
 *
 * Rejections throw a {@link LocalValidationError} the public API surfaces via the
 * debug sink; they are raised BEFORE any enqueue, so an invalid call has zero
 * durable effect.
 */

export class LocalValidationError extends Error {
  constructor(message: string) {
    super(`[analytics-sdk] ${message}`);
    this.name = 'LocalValidationError';
  }
}

/** Reject an empty / whitespace-only event name (would become a `nameless` drop). */
export function assertName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new LocalValidationError('event name must be a non-empty string');
  }
}

/** Valid economy flow types ([004-economy §3]). */
export const FLOW_TYPES = ['source', 'sink'] as const;
export type FlowType = (typeof FLOW_TYPES)[number];

/** Validate an economy payload's load-bearing fields ([004-economy §3]). */
export function assertEconomy(flowType: unknown, amount: unknown): asserts flowType is FlowType {
  if (flowType !== 'source' && flowType !== 'sink') {
    throw new LocalValidationError(`economy flow_type must be "source" or "sink", got ${JSON.stringify(flowType)}`);
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new LocalValidationError(
      `economy amount must be a positive number (magnitude only), got ${JSON.stringify(amount)}`,
    );
  }
}

/** Require a non-empty `purchase_attempt_id` on the purchase companion (§3.2). */
export function assertPurchaseAttemptId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new LocalValidationError(
      'purchaseContext requires a purchase_attempt_id (mint one via newPurchaseAttempt())',
    );
  }
}
