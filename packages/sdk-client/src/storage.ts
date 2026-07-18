/**
 * Storage adapter (spec §2.2, §4, §6 `storage` knob).
 *
 * Two logical stores behind one async interface:
 *   - a small KV store for identity + counters + the open-session record;
 *   - an ordered, capped event queue (FIFO, drop-oldest at cap).
 *
 * Selection: `auto` prefers **IndexedDB** (async, off the main thread — no
 * Phaser-loop jank), then `localStorage`, then in-memory. When persistent
 * storage is blocked (private mode, blocked IndexedDB) the adapter degrades to
 * memory-only: the SDK keeps working within the page lifetime, the operator
 * loses cross-restart continuity — degraded, never broken.
 *
 * **Never throws into game code.** Every persistence op is best-effort; a
 * quota/write failure evicts-oldest-and-counts (see queue `push`), and any hard
 * failure resolves to a safe empty/no-op result. The chosen backend is exposed
 * via {@link StorageAdapter.backend} for debug.
 */

import type { EventEnvelope } from './wire';
import type { StorageMode, DebugSink } from './config';

/** One queued event: the envelope (minus `client_sent_time`) + capture instant. */
export interface QueuedEvent {
  /** Monotonic, unique per queued row — the removal handle. */
  seq: number;
  /** The envelope as captured; `client_sent_time` is added by transport at flush. */
  envelope: EventEnvelope;
  /** Capture wall-clock ms (== envelope.client_event_time) — the TTL basis. */
  enqueued_at: number;
  /** True for money-bearing events (purchase companion) — exempt from client TTL. */
  money: boolean;
}

export type StorageBackend = 'indexeddb' | 'localstorage' | 'memory';

export interface StorageAdapter {
  readonly backend: StorageBackend;
  /** Small-value KV (identity, counters, open-session record). */
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  /**
   * Append one event. If the queue is at `cap`, drop the OLDEST first and return
   * the number dropped (a `queue_overflow` count). Never throws.
   */
  push(event: Omit<QueuedEvent, 'seq'>, cap: number): Promise<number>;
  /** Read the oldest `limit` events in FIFO order. */
  peek(limit: number): Promise<QueuedEvent[]>;
  /** Remove the given seqs (post-2xx, or TTL/4xx drop). Never throws. */
  remove(seqs: number[]): Promise<void>;
  /** Current queue length (best-effort). */
  size(): Promise<number>;
}

const KV_PREFIX = 'analytics_sdk.kv.';
const QUEUE_KEY = 'analytics_sdk.queue';

/* ------------------------------------------------------------------ memory - */

class MemoryAdapter implements StorageAdapter {
  readonly backend: StorageBackend = 'memory';
  private kv = new Map<string, string>();
  private queue: QueuedEvent[] = [];
  private nextSeq = 1;

  async getItem(key: string): Promise<string | null> {
    return this.kv.has(key) ? this.kv.get(key)! : null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.kv.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.kv.delete(key);
  }
  async push(event: Omit<QueuedEvent, 'seq'>, cap: number): Promise<number> {
    let dropped = 0;
    while (this.queue.length >= cap && this.queue.length > 0) {
      this.queue.shift();
      dropped++;
    }
    this.queue.push({ ...event, seq: this.nextSeq++ });
    return dropped;
  }
  async peek(limit: number): Promise<QueuedEvent[]> {
    return this.queue.slice(0, limit).map((e) => ({ ...e }));
  }
  async remove(seqs: number[]): Promise<void> {
    const drop = new Set(seqs);
    this.queue = this.queue.filter((e) => !drop.has(e.seq));
  }
  async size(): Promise<number> {
    return this.queue.length;
  }
}

/* ------------------------------------------------------------- localStorage - */

interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

class LocalStorageAdapter implements StorageAdapter {
  readonly backend: StorageBackend = 'localstorage';
  private nextSeq: number;

  constructor(private readonly store: WebStorageLike) {
    this.nextSeq = this.readQueue().reduce((m, e) => Math.max(m, e.seq), 0) + 1;
  }

  private readQueue(): QueuedEvent[] {
    try {
      const raw = this.store.getItem(QUEUE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as QueuedEvent[]) : [];
    } catch {
      return [];
    }
  }
  private writeQueue(q: QueuedEvent[]): boolean {
    try {
      this.store.setItem(QUEUE_KEY, JSON.stringify(q));
      return true;
    } catch {
      return false;
    }
  }

  async getItem(key: string): Promise<string | null> {
    try {
      return this.store.getItem(KV_PREFIX + key);
    } catch {
      return null;
    }
  }
  async setItem(key: string, value: string): Promise<void> {
    try {
      this.store.setItem(KV_PREFIX + key, value);
    } catch {
      /* best-effort */
    }
  }
  async removeItem(key: string): Promise<void> {
    try {
      this.store.removeItem(KV_PREFIX + key);
    } catch {
      /* best-effort */
    }
  }
  async push(event: Omit<QueuedEvent, 'seq'>, cap: number): Promise<number> {
    const q = this.readQueue();
    let dropped = 0;
    while (q.length >= cap && q.length > 0) {
      q.shift();
      dropped++;
    }
    q.push({ ...event, seq: this.nextSeq++ });
    // On a quota failure, keep evicting oldest and retry — never throw.
    while (!this.writeQueue(q) && q.length > 0) {
      q.shift();
      dropped++;
    }
    return dropped;
  }
  async peek(limit: number): Promise<QueuedEvent[]> {
    return this.readQueue().slice(0, limit);
  }
  async remove(seqs: number[]): Promise<void> {
    const drop = new Set(seqs);
    this.writeQueue(this.readQueue().filter((e) => !drop.has(e.seq)));
  }
  async size(): Promise<number> {
    return this.readQueue().length;
  }
}

/* --------------------------------------------------------------- IndexedDB - */

interface IDBFactoryLike {
  open(name: string, version?: number): IDBOpenDBRequestLike;
}
interface IDBOpenDBRequestLike {
  result: IDBDatabaseLike;
  onupgradeneeded: ((this: unknown, ev: unknown) => void) | null;
  onsuccess: ((this: unknown, ev: unknown) => void) | null;
  onerror: ((this: unknown, ev: unknown) => void) | null;
}
interface IDBDatabaseLike {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, opts?: { keyPath?: string; autoIncrement?: boolean }): IDBObjectStoreLike;
  transaction(stores: string | string[], mode?: string): IDBTransactionLike;
}
interface IDBTransactionLike {
  objectStore(name: string): IDBObjectStoreLike;
  oncomplete: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onabort: ((ev: unknown) => void) | null;
}
interface IDBRequestLike<T = unknown> {
  result: T;
  onsuccess: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
interface IDBObjectStoreLike {
  put(value: unknown, key?: unknown): IDBRequestLike;
  get(key: unknown): IDBRequestLike;
  delete(key: unknown): IDBRequestLike;
  openCursor(): IDBRequestLike<IDBCursorLike | null>;
  count(): IDBRequestLike<number>;
}
interface IDBCursorLike {
  value: QueuedEvent;
  continue(): void;
}

const DB_NAME = 'analytics_sdk';
const DB_VERSION = 1;
const KV_STORE = 'kv';
const Q_STORE = 'queue';

function reqToPromise<T>(req: IDBRequestLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('idb request failed'));
  });
}

/** Resolve when a transaction COMMITS (durability point), reject on error/abort. */
function txDone(tx: IDBTransactionLike): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error('idb tx failed'));
    tx.onabort = () => reject(new Error('idb tx aborted'));
  });
}

class IndexedDbAdapter implements StorageAdapter {
  readonly backend: StorageBackend = 'indexeddb';
  private constructor(
    private readonly db: IDBDatabaseLike,
    private nextSeq: number,
  ) {}

  static async open(factory: IDBFactoryLike): Promise<IndexedDbAdapter> {
    const db = await new Promise<IDBDatabaseLike>((resolve, reject) => {
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(KV_STORE)) d.createObjectStore(KV_STORE);
        if (!d.objectStoreNames.contains(Q_STORE)) d.createObjectStore(Q_STORE, { keyPath: 'seq' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('idb open failed'));
    });
    // Recover the seq high-water mark from any surviving queue rows.
    let maxSeq = 0;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(Q_STORE, 'readonly');
      const cursorReq = tx.objectStore(Q_STORE).openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          maxSeq = Math.max(maxSeq, cursor.value.seq);
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
    return new IndexedDbAdapter(db, maxSeq + 1);
  }

  async getItem(key: string): Promise<string | null> {
    try {
      const tx = this.db.transaction(KV_STORE, 'readonly');
      const v = await reqToPromise(tx.objectStore(KV_STORE).get(key) as IDBRequestLike<string | undefined>);
      return v ?? null;
    } catch {
      return null;
    }
  }
  async setItem(key: string, value: string): Promise<void> {
    try {
      const tx = this.db.transaction(KV_STORE, 'readwrite');
      tx.objectStore(KV_STORE).put(value, key);
      await txDone(tx);
    } catch {
      /* best-effort */
    }
  }
  async removeItem(key: string): Promise<void> {
    try {
      const tx = this.db.transaction(KV_STORE, 'readwrite');
      tx.objectStore(KV_STORE).delete(key);
      await txDone(tx);
    } catch {
      /* best-effort */
    }
  }
  async push(event: Omit<QueuedEvent, 'seq'>, cap: number): Promise<number> {
    try {
      let dropped = 0;
      const current = await this.size();
      const overBy = current + 1 - cap;
      if (overBy > 0) {
        const oldest = await this.peek(overBy);
        await this.remove(oldest.map((e) => e.seq));
        dropped += oldest.length;
      }
      const row: QueuedEvent = { ...event, seq: this.nextSeq++ };
      const tx = this.db.transaction(Q_STORE, 'readwrite');
      tx.objectStore(Q_STORE).put(row);
      await txDone(tx);
      return dropped;
    } catch {
      // Quota/write failure: evict the oldest to make room, count it, do not throw.
      try {
        const oldest = await this.peek(1);
        if (oldest.length > 0) await this.remove(oldest.map((e) => e.seq));
      } catch {
        /* give up quietly */
      }
      return 1;
    }
  }
  async peek(limit: number): Promise<QueuedEvent[]> {
    try {
      return await new Promise<QueuedEvent[]>((resolve) => {
        const out: QueuedEvent[] = [];
        const tx = this.db.transaction(Q_STORE, 'readonly');
        const cursorReq = tx.objectStore(Q_STORE).openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && out.length < limit) {
            out.push(cursor.value);
            cursor.continue();
          }
        };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => resolve(out);
        tx.onabort = () => resolve(out);
      });
    } catch {
      return [];
    }
  }
  async remove(seqs: number[]): Promise<void> {
    try {
      const tx = this.db.transaction(Q_STORE, 'readwrite');
      const store = tx.objectStore(Q_STORE);
      for (const seq of seqs) store.delete(seq);
      await new Promise<void>((resolve) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch {
      /* best-effort */
    }
  }
  async size(): Promise<number> {
    try {
      const tx = this.db.transaction(Q_STORE, 'readonly');
      return await reqToPromise(tx.objectStore(Q_STORE).count());
    } catch {
      return 0;
    }
  }
}

/* ---------------------------------------------------------------- selection - */

interface StorageGlobals {
  indexedDB?: IDBFactoryLike;
  localStorage?: WebStorageLike;
}

/** Probe whether localStorage is actually usable (private mode throws on write). */
function localStorageUsable(ls: WebStorageLike | undefined): ls is WebStorageLike {
  if (!ls) return false;
  try {
    const probe = '__analytics_sdk_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the best available storage adapter for `mode`. `auto` walks
 * IndexedDB → localStorage → memory. An explicit mode falls back to memory if
 * unavailable rather than throwing (degrade-never-break).
 */
export async function createStorage(mode: StorageMode, debug?: DebugSink): Promise<StorageAdapter> {
  const g = globalThis as unknown as StorageGlobals;

  const tryIdb = async (): Promise<StorageAdapter | null> => {
    if (!g.indexedDB) return null;
    try {
      return await IndexedDbAdapter.open(g.indexedDB);
    } catch {
      return null;
    }
  };
  const tryLs = (): StorageAdapter | null =>
    localStorageUsable(g.localStorage) ? new LocalStorageAdapter(g.localStorage) : null;

  let adapter: StorageAdapter | null = null;
  if (mode === 'indexeddb') adapter = await tryIdb();
  else if (mode === 'localstorage') adapter = tryLs();
  else if (mode === 'memory') adapter = new MemoryAdapter();
  else adapter = (await tryIdb()) ?? tryLs();

  if (!adapter) {
    if (mode !== 'auto' && mode !== 'memory') {
      debug?.warn?.(
        `[analytics-sdk] storage "${mode}" unavailable; falling back to memory (no cross-restart persistence).`,
      );
    }
    adapter = new MemoryAdapter();
  }
  return adapter;
}
