/**
 * Jest setup for the client SDK. jsdom provides `window`/`document`/`crypto`;
 * `fake-indexeddb/auto` installs a spec-compliant in-memory IndexedDB so the
 * `auto` storage path exercises the real IndexedDB adapter (not the memory
 * fallback). A `TextEncoder`/`TextDecoder` polyfill covers jsdom gaps.
 */
import { TextEncoder, TextDecoder } from 'node:util';

const g = globalThis as unknown as {
  TextEncoder?: unknown;
  TextDecoder?: unknown;
  crypto?: unknown;
  structuredClone?: unknown;
};
if (!g.TextEncoder) g.TextEncoder = TextEncoder;
if (!g.TextDecoder) g.TextDecoder = TextDecoder;

// jsdom's environment does not expose Node 20+'s global `structuredClone`, which
// fake-indexeddb requires to clone stored values. Bridge it from Node's globals
// BEFORE fake-indexeddb loads (its writes otherwise silently fail to persist).
if (typeof g.structuredClone !== 'function') {
  const nodeStructuredClone = (globalThis as { structuredClone?: unknown }).structuredClone;
  g.structuredClone =
    typeof nodeStructuredClone === 'function'
      ? nodeStructuredClone
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (v: any): any => JSON.parse(JSON.stringify(v));
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('fake-indexeddb/auto');

// jsdom may lack Web Crypto in some versions — provide Node's if absent.
if (!g.crypto || typeof (g.crypto as { getRandomValues?: unknown }).getRandomValues !== 'function') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeCrypto = require('node:crypto');
  g.crypto = nodeCrypto.webcrypto;
}
