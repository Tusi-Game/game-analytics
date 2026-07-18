/**
 * The package semver, stamped into `sdk.version` on every batch (Q9 provenance).
 * Decoupled from the wire version (`v:1` forever). Kept in sync with
 * package.json by the release flow; a single constant keeps the wire descriptor
 * from importing the manifest at runtime.
 */
export const SDK_VERSION = '0.1.0';
