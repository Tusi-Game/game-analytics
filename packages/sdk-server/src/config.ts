/**
 * Server SDK configuration (spec §6). All knobs are SDK-local (no `GAME.config`
 * mirror, no FX knob, no dedup window — those are platform machinery).
 */

/** Failure + diagnostics hook. NEVER throws into caller code (contract 9). */
export type OnError = (err: unknown, context: { fatal: boolean; detail?: string }) => void;

export interface ServerConfigInput {
  /** Self-hosted platform base URL; SDK appends `/v1/events`. Required. */
  endpoint: string;
  /** Secret server credential (env / secret-manager by convention). Required. */
  serverCredential: string;
  flush_interval_ms?: number;
  batch_max_events?: number;
  flush_on_purchase?: boolean;
  retry_backoff_base_ms?: number;
  retry_backoff_max_ms?: number;
  retry_max_elapsed_ms?: number;
  queue_max_events?: number;
  on_error?: OnError;
  debug?: boolean;
}

export interface ResolvedServerConfig {
  endpoint: string;
  serverCredential: string;
  flush_interval_ms: number;
  batch_max_events: number;
  flush_on_purchase: boolean;
  retry_backoff_base_ms: number;
  retry_backoff_max_ms: number;
  retry_max_elapsed_ms: number;
  queue_max_events: number;
  on_error: OnError;
  debug: boolean;
}

function num(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveConfig(input: ServerConfigInput): ResolvedServerConfig {
  if (typeof input.endpoint !== 'string' || input.endpoint.trim() === '') {
    throw new Error('[analytics-sdk-server] init: endpoint is required');
  }
  return {
    endpoint: input.endpoint.replace(/\/+$/, ''),
    serverCredential: input.serverCredential,
    flush_interval_ms: num(input.flush_interval_ms, 5_000),
    batch_max_events: num(input.batch_max_events, 100),
    flush_on_purchase: input.flush_on_purchase ?? true,
    retry_backoff_base_ms: num(input.retry_backoff_base_ms, 1_000),
    retry_backoff_max_ms: num(input.retry_backoff_max_ms, 60_000),
    retry_max_elapsed_ms: num(input.retry_max_elapsed_ms, 900_000),
    queue_max_events: num(input.queue_max_events, 10_000),
    on_error: input.on_error ?? (() => {}),
    debug: input.debug ?? false,
  };
}
