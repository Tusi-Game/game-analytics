/**
 * Collision-safe id minting (Foundation §4.1, spec §3.1 `event_id` row).
 *
 * Order of preference:
 *   1. `crypto.randomUUID()` — but it is **secure-context-only** (absent on
 *      plain-HTTP origins and old webviews), so we feature-detect.
 *   2. `crypto.getRandomValues()`-seeded RFC-4122 v4 UUID — works wherever the
 *      Web Crypto RNG exists (non-secure contexts included).
 *   3. A bundled entropy path over `getRandomValues` as a last resort.
 *
 * **Never `Math.random`** — it collides and can be deterministic across cloned
 * sessions, which would silently over- or under-dedup on the server side.
 *
 * `event_id`, `session_id`, `anon_id`, and `purchase_attempt_id` are all minted
 * here. The server treats them as opaque; we only require global uniqueness.
 */

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
}

function getCrypto(): CryptoLike | undefined {
  const g = globalThis as unknown as { crypto?: CryptoLike };
  return g.crypto;
}

/** RFC-4122 v4 UUID from 16 cryptographically-random bytes. */
function uuidV4FromBytes(bytes: Uint8Array): string {
  // Version + variant bits per RFC 4122 §4.4.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 256; i++) {
    hex.push((i + 0x100).toString(16).slice(1));
  }
  const b = bytes;
  return (
    hex[b[0]!]! +
    hex[b[1]!]! +
    hex[b[2]!]! +
    hex[b[3]!]! +
    '-' +
    hex[b[4]!]! +
    hex[b[5]!]! +
    '-' +
    hex[b[6]!]! +
    hex[b[7]!]! +
    '-' +
    hex[b[8]!]! +
    hex[b[9]!]! +
    '-' +
    hex[b[10]!]! +
    hex[b[11]!]! +
    hex[b[12]!]! +
    hex[b[13]!]! +
    hex[b[14]!]! +
    hex[b[15]!]!
  );
}

/**
 * Mint a collision-safe unique id. Throws only if NO cryptographic RNG is
 * reachable at all — an environment where the SDK cannot guarantee dedup safety
 * and must not silently degrade to `Math.random`.
 */
export function mintId(): string {
  const c = getCrypto();
  if (c?.randomUUID) {
    try {
      return c.randomUUID();
    } catch {
      // Secure-context guard threw despite the method existing; fall through.
    }
  }
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return uuidV4FromBytes(bytes);
  }
  throw new Error(
    '[analytics-sdk] no cryptographic RNG available (crypto.randomUUID / crypto.getRandomValues); ' +
      'refusing to mint ids with Math.random (would break server dedup).',
  );
}
