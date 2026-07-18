/**
 * The public client SDK surface (spec §5). One `init`, a handful of verbs.
 *
 * Ordering guarantee (Design §Relations): per event,
 *   event_id mint ≺ persistent enqueue ≺ flush-time client_sent_time ≺ 2xx ≺ removal.
 * Every capture returns AFTER durable enqueue (P11 — gameplay never blocked;
 * transport/retry are off the hot path). The transport, session tracker, and
 * identity are single-owner (Design §Module).
 */

import { assertClientKey } from './credential';
import { resolveConfig, type ClientConfigInput, type DebugSink } from './config';
import { createStorage, type StorageAdapter } from './storage';
import { Identity } from './identity';
import { OfflineQueue } from './queue';
import { buildEnvelope, type CapturedEnvelope } from './envelope-factory';
import { SessionTracker, type SessionEmit } from './session';
import { Transport } from './transport';
import { assertName, assertEconomy, assertPurchaseAttemptId, type FlowType } from './validation';
import { mintId } from './ids';
import { SDK_VERSION } from './version';

/** Optional context on the purchase companion (§3.2) — zero money by construction. */
export interface PurchaseContextInput {
  player_level?: number;
  region?: string;
  in_game_state?: string;
  /** If the client happens to know it; the join key is purchase_attempt_id. */
  transaction_id?: string;
}

/** Optional context on an economy flow (§3.2). */
export interface EconomyContext {
  balance_after?: number;
  player_level?: number;
  region?: string;
  [key: string]: unknown;
}

interface Timers {
  setTimer: (cb: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

/** Test seams — injectable clocks/timers/transport. All optional. */
export interface ClientTestHooks {
  now?: () => number;
  monotonic?: () => number;
  timers?: Timers;
  storage?: StorageAdapter;
  fetchImpl?: (url: string, init: unknown) => Promise<{ status: number }>;
  sendBeaconImpl?: (url: string, data: unknown) => boolean;
}

const defaultTimers: Timers = {
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function defaultMonotonic(): number {
  const p = (globalThis as unknown as { performance?: { now?: () => number } }).performance;
  return p?.now ? p.now() : Date.now();
}

export class AnalyticsClient {
  private constructor(
    private readonly debug: DebugSink,
    private readonly identity: Identity,
    private readonly queue: OfflineQueue,
    private readonly session: SessionTracker,
    private readonly transport: Transport,
    private readonly now: () => number,
  ) {}

  /**
   * Initialize the SDK. Fails fast (before any network/state) if `sdkKey` is not
   * a client-class key. Loads persisted state, runs session reconcile (may
   * enqueue one `reason=reconciled` session event), and starts the flush loop +
   * browser lifecycle listeners.
   */
  static async init(input: ClientConfigInput, hooks: ClientTestHooks = {}): Promise<AnalyticsClient> {
    assertClientKey(input.sdkKey); // fail-fast, pre-network (Foundation §4.5)
    const config = resolveConfig(input);
    const debug: DebugSink = config.debug
      ? { warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) }
      : { warn: () => {}, error: () => {} };

    const now = hooks.now ?? Date.now;
    const monotonic = hooks.monotonic ?? defaultMonotonic;
    const timers = hooks.timers ?? defaultTimers;

    const storage = hooks.storage ?? (await createStorage(config.storage, debug));
    const identity = await Identity.load(storage, now());
    const queue = new OfflineQueue(storage, config.offline_queue_max_events);

    // The session tracker enqueues terminal events via this callback so it stays
    // decoupled from the queue/identity concretes.
    const emitTerminal = async (e: SessionEmit): Promise<void> => {
      const env = buildEnvelope(
        {
          name: 'session',
          kind: 'session',
          clientEventTime: e.session_end_time,
          sessionIdOverride: e.session_id,
          props: {
            session_id: e.session_id,
            session_start_time: e.session_start_time,
            session_end_time: e.session_end_time,
            duration_ms: e.duration_ms,
            reason: e.reason,
          },
        },
        { anonId: identity.anonId, userId: identity.userId, sessionId: e.session_id },
      );
      await queue.enqueue(env, false, now());
    };

    const session = new SessionTracker({
      storage,
      inactivityTimeoutMin: config.session_inactivity_timeout_min,
      now,
      monotonic,
      emitTerminal,
      bumpCounter: () => identity.bumpSessionCounter(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const transport = new Transport({
      config,
      queue,
      sdkVersion: SDK_VERSION,
      debug,
      now,
      fetchImpl: hooks.fetchImpl as never,
      sendBeaconImpl: hooks.sendBeaconImpl as never,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const client = new AnalyticsClient(debug, identity, queue, session, transport, now);
    // Reconcile the killed-app path BEFORE the first new session (§2.1 R).
    await session.reconcile();
    transport.start();
    client.installLifecycleListeners(timers);
    return client;
  }

  /** Register a browser unload/visibility flush (spec §2.1). No-op off-DOM. */
  private installLifecycleListeners(_timers: Timers): void {
    const doc = (globalThis as unknown as { document?: EventTargetLike }).document;
    const win = globalThis as unknown as { addEventListener?: EventTargetLike['addEventListener'] };
    const onHide = (): void => {
      // Close the session (app_close) and beacon the tail — best-effort.
      void this.session.close('app_close').then(() => this.transport.unloadFlush());
    };
    try {
      if (doc?.addEventListener) {
        doc.addEventListener('visibilitychange', () => {
          const vis = (doc as unknown as { visibilityState?: string }).visibilityState;
          if (vis === 'hidden') onHide();
        });
      }
      if (win.addEventListener) {
        win.addEventListener('pagehide', onHide);
      }
    } catch {
      /* environments without DOM lifecycle — appClose() is the manual path */
    }
  }

  /** Emit one generic event (spec §5 `track`). Returns after durable enqueue. */
  async track(name: string, props: Record<string, unknown> = {}): Promise<void> {
    assertName(name);
    await this.capture(name, 'generic', props, false);
  }

  /** Emit one client-provenance economy flow (spec §5 `economy`). */
  async economy(
    flowType: FlowType,
    currencyType: string,
    amount: number,
    reason: string,
    context: EconomyContext = {},
  ): Promise<void> {
    assertEconomy(flowType, amount);
    const props: Record<string, unknown> = {
      ...context,
      flow_type: flowType,
      currency_type: currencyType,
      amount,
      reason,
    };
    await this.capture('economy', 'economy', props, false);
  }

  /**
   * Mint + return a `purchase_attempt_id` (spec §5 `newPurchaseAttempt`). Thread
   * it into the store call (appAccountToken / obfuscatedAccountId) AND into
   * `purchaseContext`, so the server revenue row and this companion join on it.
   */
  newPurchaseAttempt(): string {
    return mintId();
  }

  /**
   * Emit the ZERO-MONEY purchase companion (spec §3.2, §5 `purchaseContext`).
   * Structurally carries no money fields; auto-stamps `sessions_before_purchase`
   * (current counter) and `days_since_install`; `source=client`.
   */
  async purchaseContext(purchaseAttemptId: string, context: PurchaseContextInput = {}): Promise<void> {
    assertPurchaseAttemptId(purchaseAttemptId);
    // Bump session activity FIRST so `sessions_before_purchase` reflects the
    // session this purchase is IN ("this purchase happened in session N", §3.4).
    const sessionId = await this.session.onCapture();
    // Zero-money by construction: only enrichment fields are ever assembled here.
    const props: Record<string, unknown> = {
      purchase_attempt_id: purchaseAttemptId,
      source: 'client',
      sessions_before_purchase: this.identity.sessionCounter,
      days_since_install: this.identity.daysSinceInstall(this.now()),
    };
    if (context.player_level !== undefined) props.player_level = context.player_level;
    if (context.region !== undefined) props.region = context.region;
    if (context.in_game_state !== undefined) props.in_game_state = context.in_game_state;
    if (context.transaction_id !== undefined) props.transaction_id = context.transaction_id;
    const env = buildEnvelope(
      { name: 'purchase', kind: 'purchase', clientEventTime: this.now(), props },
      { anonId: this.identity.anonId, userId: this.identity.userId, sessionId },
    );
    // TTL-exempt: the purchase companion is purchase-related and valuable, so it
    // is never dropped by the client-side TTL (the server absorbs any redelivery
    // via the durable purchase gate). It still carries ZERO money.
    await this.queue.enqueue(env, true, this.now());
  }

  /**
   * Persist a `user_id` (spec §5 `identify`). Queued events keep their
   * capture-time identity (no restamp, no history merge). On the FIRST identify
   * after an anon-only span, emit a one-off `identify` alias edge carrying
   * `(anon_id, user_id)` (Foundation §4.6).
   */
  async identify(userId: string): Promise<void> {
    if (typeof userId !== 'string' || userId.trim() === '') {
      this.debug.warn('[analytics-sdk] identify: user_id must be a non-empty string; ignored');
      return;
    }
    const firstEver = !this.identity.identifiedOnce;
    const anonId = this.identity.anonId;
    await this.identity.setUserId(userId);
    if (firstEver) {
      // The identity edge — captured so a future retroactive stitch stays possible.
      const sessionId = await this.session.onCapture();
      const env = buildEnvelope(
        {
          name: 'identify',
          kind: 'generic',
          clientEventTime: this.now(),
          props: { alias: { anon_id: anonId, user_id: userId } },
        },
        { anonId, userId, sessionId },
      );
      await this.queue.enqueue(env, false, this.now());
      await this.identity.markIdentified();
    }
  }

  /** Explicit app-close (spec §5 `appClose`): close session + best-effort flush. */
  async appClose(): Promise<void> {
    await this.session.close('app_close');
    await this.transport.flush();
  }

  /** Force an immediate transmit attempt of the backlog (spec §5 `flush`). */
  async flush(): Promise<void> {
    await this.transport.flush();
  }

  /** Stop timers + lifecycle (test/host teardown). Does not emit. */
  dispose(): void {
    this.session.dispose();
    this.transport.dispose();
  }

  /** Debug snapshot — drop counters, storage backend, pause state. */
  debugState(): { queue: { overflowDropped: number; ttlDropped: number }; transportPaused: boolean } {
    return { queue: this.queue.stats, transportPaused: this.transport.isPaused };
  }

  /** The shared capture path: session activity + envelope build + durable enqueue. */
  private async capture(
    name: string,
    kind: CapturedEnvelope['kind'],
    props: Record<string, unknown>,
    money: boolean,
  ): Promise<void> {
    const sessionId = await this.session.onCapture(); // bumps activity / lazy-starts
    const env = buildEnvelope(
      { name, kind, clientEventTime: this.now(), props },
      { anonId: this.identity.anonId, userId: this.identity.userId, sessionId },
    );
    await this.queue.enqueue(env, money, this.now());
  }
}

/** Minimal event-target surface (avoids a DOM lib dependency). */
interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void;
}
