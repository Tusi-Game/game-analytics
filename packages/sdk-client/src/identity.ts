/**
 * Persistent identity + counters (spec §3.1, §3.4, §4, Foundation §4.6).
 *
 *   - `anon_id`         — minted (unique id) write-once at first-ever init;
 *                         rides every envelope forever (per storage scope).
 *   - `user_id`         — last `identify` value; carried on future captures.
 *   - install timestamp — first-ever init wall time (write-once); backs
 *                         `days_since_install`.
 *   - session counter   — monotonic lifetime count of sessions started; backs
 *                         `sessions_before_purchase`.
 *   - `identified_once` — whether an `identify` alias edge has already been
 *                         emitted (Foundation §4.6 edge is one-off).
 *
 * All values are cached in memory after load; every mutation writes through to
 * storage best-effort (never throws).
 */

import type { StorageAdapter } from './storage';
import { mintId } from './ids';

const K_ANON = 'anon_id';
const K_USER = 'user_id';
const K_INSTALL = 'install_ts';
const K_SESSION_COUNTER = 'session_counter';
const K_IDENTIFIED = 'identified_once';

export class Identity {
  private constructor(
    private readonly storage: StorageAdapter,
    private _anonId: string,
    private _installTs: number,
    private _sessionCounter: number,
    private _userId: string | undefined,
    private _identifiedOnce: boolean,
  ) {}

  /** Load persisted identity, minting `anon_id` + install-ts on first-ever init. */
  static async load(storage: StorageAdapter, now: number): Promise<Identity> {
    let anonId = await storage.getItem(K_ANON);
    if (!anonId) {
      anonId = mintId();
      await storage.setItem(K_ANON, anonId);
    }
    const installRaw = await storage.getItem(K_INSTALL);
    let installTs = installRaw !== null ? Number(installRaw) : NaN;
    if (!Number.isFinite(installTs)) {
      installTs = now;
      await storage.setItem(K_INSTALL, String(installTs));
    }
    const counterRaw = await storage.getItem(K_SESSION_COUNTER);
    const sessionCounter = Number.isFinite(Number(counterRaw)) ? Number(counterRaw) : 0;
    const userId = (await storage.getItem(K_USER)) ?? undefined;
    const identifiedOnce = (await storage.getItem(K_IDENTIFIED)) === '1';
    return new Identity(storage, anonId, installTs, sessionCounter, userId, identifiedOnce);
  }

  get anonId(): string {
    return this._anonId;
  }
  get userId(): string | undefined {
    return this._userId;
  }
  get installTs(): number {
    return this._installTs;
  }
  get sessionCounter(): number {
    return this._sessionCounter;
  }
  get identifiedOnce(): boolean {
    return this._identifiedOnce;
  }

  /** Whole UTC days elapsed since first install (§3.4 `days_since_install`). */
  daysSinceInstall(now: number): number {
    const MS_PER_DAY = 86_400_000;
    return Math.max(0, Math.floor((now - this._installTs) / MS_PER_DAY));
  }

  /** Persist a new `user_id` (subsequent captures carry it). */
  async setUserId(userId: string): Promise<void> {
    this._userId = userId;
    await this.storage.setItem(K_USER, userId);
  }

  /** Mark the one-off identify alias edge as emitted. */
  async markIdentified(): Promise<void> {
    this._identifiedOnce = true;
    await this.storage.setItem(K_IDENTIFIED, '1');
  }

  /** Increment + persist the lifetime session counter (called at session mint). */
  async bumpSessionCounter(): Promise<number> {
    this._sessionCounter += 1;
    await this.storage.setItem(K_SESSION_COUNTER, String(this._sessionCounter));
    return this._sessionCounter;
  }
}
