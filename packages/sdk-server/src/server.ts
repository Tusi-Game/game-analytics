/**
 * The public server SDK surface (spec §5). The TRUSTED emitter — money +
 * economy truth. Every call implies `provenance=server` (there is no per-call
 * trust downgrade). All emit calls are non-blocking (enqueue-and-return);
 * failures route to `on_error` — never a thrown exception in the caller's payment
 * path (contract 9), the SOLE exception being a money-overflow which surfaces
 * synchronously (money is never silently dropped).
 */

import { assertServerCredential } from './credential';
import { resolveConfig, type ServerConfigInput, type ResolvedServerConfig } from './config';
import { buildEnvelope } from './envelope-builder';
import { OutboundQueue, QueueOverflowError } from './queue';
import { ServerTransport } from './transport';
import type { FlowType } from './wire-kinds';

/** Caller-supplied fields for the authoritative verified revenue row (§3). */
export interface VerifiedPurchaseInput {
  userId: string;
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  productCategory: string;
  priceLocal: number;
  currency: string;
  verified: boolean;
  environment: 'prod' | 'sandbox';
  /** The client-minted context-join key, relayed from the store call (R2). Optional. */
  purchaseAttemptId?: string;
  refunded?: boolean;
  /** Extra free-form context (rides inside props). Never money. */
  props?: Record<string, unknown>;
}

/** Caller-supplied fields for a server-provenance economy flow (§3). */
export interface EconomyInput {
  userId: string;
  flowType: FlowType;
  currencyType: string;
  amount: number;
  reason: string;
  balanceAfter?: number;
  props?: Record<string, unknown>;
}

export interface TrackOptions {
  userId: string;
  sessionId?: string;
}

interface ServerTestHooks {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: (url: string, init: unknown) => Promise<{ status: number }>;
}

export class AnalyticsServer {
  private constructor(
    private readonly config: ResolvedServerConfig,
    private readonly queue: OutboundQueue,
    private readonly transport: ServerTransport,
    private readonly now: () => number,
  ) {}

  /**
   * Initialize. Fails fast (pre-network) if `serverCredential` is not a
   * server-class (`sk_`) credential — a public client key is a config error,
   * never a silent provenance downgrade.
   */
  static init(input: ServerConfigInput, hooks: ServerTestHooks = {}): AnalyticsServer {
    assertServerCredential(input.serverCredential);
    const config = resolveConfig(input);
    const now = hooks.now ?? Date.now;
    const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const queue = new OutboundQueue(config.queue_max_events);
    const transport = new ServerTransport({
      config,
      queue,
      now,
      sleep,
      fetchImpl: hooks.fetchImpl as never,
    });
    const server = new AnalyticsServer(config, queue, transport, now);
    transport.start();
    return server;
  }

  /**
   * Emit ONE authoritative verified revenue row (`kind=purchase`,
   * `source=server`) carrying the full [006-monetization §3] required set. NO
   * local dedup (the durable `transaction_id` gate is truth); NO FX / normalized
   * amount EVER (Q8). Relays `purchase_attempt_id` (R2). Non-blocking, except a
   * money-overflow surfaces synchronously ({@link QueueOverflowError}).
   */
  verifiedPurchase(input: VerifiedPurchaseInput): void {
    if (input.purchaseAttemptId === undefined && this.config.debug) {
      this.config.on_error(
        new Error(
          '[analytics-sdk-server] verifiedPurchase without purchase_attempt_id — the purchase counts but segmented dimensions will be missing (relay it via appAccountToken / obfuscatedAccountId).',
        ),
        { fatal: false, detail: 'reduced-dimensions warning' },
      );
    }
    // Zero FX: price_local + ISO currency raw; normalized_amount NEVER on the wire.
    const props: Record<string, unknown> = {
      ...(input.props ?? {}),
      source: 'server',
      transaction_id: input.transactionId,
      original_transaction_id: input.originalTransactionId,
      product_id: input.productId,
      product_category: input.productCategory,
      price_local: input.priceLocal,
      currency: input.currency,
      verified: input.verified,
      environment: input.environment,
    };
    if (input.purchaseAttemptId !== undefined) props.purchase_attempt_id = input.purchaseAttemptId;
    if (input.refunded !== undefined) props.refunded = input.refunded;

    const env = buildEnvelope({
      name: 'purchase',
      kind: 'purchase',
      userId: input.userId,
      clientEventTime: this.now(),
      props,
    });
    this.enqueueMoney(env);
    if (this.config.flush_on_purchase) void this.transport.flush();
  }

  /**
   * Emit ONE server-provenance economy flow (`kind=economy`). No provenance field
   * is sent ([004-economy] derives it from the credential). Non-blocking.
   */
  economy(input: EconomyInput): void {
    const props: Record<string, unknown> = {
      ...(input.props ?? {}),
      flow_type: input.flowType,
      currency_type: input.currencyType,
      amount: input.amount,
      reason: input.reason,
    };
    if (input.balanceAfter !== undefined) props.balance_after = input.balanceAfter;
    const env = buildEnvelope({
      name: 'economy',
      kind: 'economy',
      userId: input.userId,
      clientEventTime: this.now(),
      props,
    });
    this.enqueueNonMoney(env);
  }

  /** Emit ONE generic event (`kind=generic`). Non-blocking. */
  track(name: string, props: Record<string, unknown>, opts: TrackOptions): void {
    if (typeof name !== 'string' || name.trim() === '') {
      this.config.on_error(new Error('[analytics-sdk-server] track: name must be non-empty'), { fatal: false });
      return;
    }
    const env = buildEnvelope({
      name,
      kind: 'generic',
      userId: opts.userId,
      clientEventTime: this.now(),
      props: props ?? {},
      sessionId: opts.sessionId,
    });
    this.enqueueNonMoney(env);
  }

  /** Force a drain; resolves on ack or retry-budget exhaustion (spec §5). */
  async flush(): Promise<void> {
    await this.transport.flush();
  }

  /** Final flush + stop timers, for graceful backend termination (spec §5). */
  async shutdown(): Promise<void> {
    await this.transport.flush();
    this.transport.dispose();
  }

  /** Debug snapshot. */
  debugState(): { queueSize: number; nonMoneyDropped: number } {
    return { queueSize: this.queue.size(), nonMoneyDropped: this.queue.nonMoneyDropped };
  }

  private enqueueMoney(env: ReturnType<typeof buildEnvelope>): void {
    // Money overflow throws synchronously — the only non-blocking exception.
    this.queue.enqueue(env, true);
  }

  private enqueueNonMoney(env: ReturnType<typeof buildEnvelope>): void {
    try {
      this.queue.enqueue(env, false);
    } catch (err) {
      // Non-money never throws; route to on_error (analytics never breaks the caller).
      if (!(err instanceof QueueOverflowError)) this.config.on_error(err, { fatal: false });
    }
  }
}
