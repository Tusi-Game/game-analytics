/**
 * Credential-class fail-fast (Foundation §4.5, Q2) — server SDK side.
 *
 * The server SDK is the TRUSTED money/economy path. It authenticates with a
 * secret `sk_`-prefixed `server_credential`. A public `pk_` client `sdk_key`
 * supplied here is a configuration error — accepting it would be a silent
 * downgrade to `provenance=client` (zero-money, spoofable), so `init` REJECTS it
 * **before any network call**.
 *
 * Prefix grammar mirrors the server's `credential-hash.ts` exactly.
 */

export const CLIENT_KEY_PREFIX = 'pk_';
export const SERVER_CREDENTIAL_PREFIX = 'sk_';

export function assertServerCredential(credential: string): void {
  if (typeof credential !== 'string' || credential.trim() === '') {
    throw new Error('[analytics-sdk-server] init: server_credential is required');
  }
  if (credential.startsWith(CLIENT_KEY_PREFIX)) {
    throw new Error(
      '[analytics-sdk-server] init: a PUBLIC client sdk_key (pk_) was supplied to the SERVER SDK. ' +
        'The server SDK emits trusted money/economy truth and requires a secret server credential (sk_). ' +
        'Accepting a client key would silently downgrade provenance to client (zero-money). Refusing to initialize.',
    );
  }
  if (!credential.startsWith(SERVER_CREDENTIAL_PREFIX)) {
    throw new Error(
      `[analytics-sdk-server] init: server_credential must be a server-class credential (starts with "${SERVER_CREDENTIAL_PREFIX}"). ` +
        'Refusing to initialize with an unrecognized credential class.',
    );
  }
}
