/**
 * Credential-class fail-fast (Foundation §4.5, Q2).
 *
 * The client SDK is the PUBLIC, embeddable, spoofable path — it authenticates
 * with a `pk_`-prefixed `sdk_key`. Shipping a secret `sk_` server credential
 * inside a game build is a catastrophic configuration error (it would make an
 * attacker's events money-truth), so `init` REJECTS a wrong-class key
 * **before any network call** — never a silent downgrade.
 *
 * The prefix grammar mirrors the server's `credential-hash.ts` exactly:
 *   `pk_` — public client `sdk_key`   (this SDK)
 *   `sk_` — secret server credential  (the server SDK — rejected here)
 */

/** Public client key marker. */
export const CLIENT_KEY_PREFIX = 'pk_';
/** Secret server credential marker (must never ship in a client build). */
export const SERVER_CREDENTIAL_PREFIX = 'sk_';

/**
 * Throw unless `sdkKey` is a well-formed client-class key. Called at the top of
 * `init`, before any state load or network activity.
 */
export function assertClientKey(sdkKey: string): void {
  if (typeof sdkKey !== 'string' || sdkKey.trim() === '') {
    throw new Error('[analytics-sdk] init: sdk_key is required');
  }
  if (sdkKey.startsWith(SERVER_CREDENTIAL_PREFIX)) {
    throw new Error(
      '[analytics-sdk] init: a SECRET server credential (sk_) was supplied to the CLIENT SDK. ' +
        'The client SDK ships inside public game builds and must use a public sdk_key (pk_). ' +
        'A server credential here would let anyone forge money-truth events. Refusing to initialize.',
    );
  }
  if (!sdkKey.startsWith(CLIENT_KEY_PREFIX)) {
    throw new Error(
      `[analytics-sdk] init: sdk_key must be a client-class key (starts with "${CLIENT_KEY_PREFIX}"). ` +
        'Refusing to initialize with an unrecognized credential class.',
    );
  }
}
