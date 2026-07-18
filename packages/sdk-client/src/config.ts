/**
 * Client SDK configuration (spec §6). One knob (`session_inactivity_timeout_min`)
 * mirrors a server knob ([003-sessions §6]); the rest are SDK-local. There is NO
 * remote config in v1 — the operator keeps the mirrored knob in agreement by
 * hand (Design §Relations flag 2).
 */

/** Storage-adapter selection (§4). `auto` prefers IndexedDB, then localStorage, then memory. */
export type StorageMode = 'auto' | 'indexeddb' | 'localstorage' | 'memory';

/** gzip request-body compression selection (§6 `compress`). */
export type CompressMode = 'auto' | 'on' | 'off';

/** Diagnostic sink; defaults to `console`. Never throws into game code. */
export interface DebugSink {
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** User-supplied init options (the config half of `init`). */
export interface ClientConfigInput {
  /** Base URL; events POST to `{endpoint}/v1/events`. Required. */
  endpoint: string;
  /** Client-class `sdk_key` (prefix-checked at init). Required. */
  sdkKey: string;
  session_inactivity_timeout_min?: number;
  batch_max_events?: number;
  flush_interval_ms?: number;
  offline_queue_max_events?: number;
  retry_backoff_base_ms?: number;
  retry_backoff_max_ms?: number;
  storage?: StorageMode;
  batch_max_bytes?: number;
  compress?: CompressMode;
  event_ttl_ms?: number;
  debug?: boolean;
}

/** The fully-resolved config, defaults applied and ranges clamped. */
export interface ResolvedClientConfig {
  endpoint: string;
  sdkKey: string;
  session_inactivity_timeout_min: number;
  batch_max_events: number;
  flush_interval_ms: number;
  offline_queue_max_events: number;
  retry_backoff_base_ms: number;
  retry_backoff_max_ms: number;
  storage: StorageMode;
  batch_max_bytes: number;
  compress: CompressMode;
  event_ttl_ms: number;
  debug: boolean;
}

/** ~64 KB — the sendBeacon payload ceiling the unload flush stays under. */
export const BEACON_MAX_BYTES = 64_000;

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Apply defaults + range clamps (spec §6 table). */
export function resolveConfig(input: ClientConfigInput): ResolvedClientConfig {
  if (typeof input.endpoint !== 'string' || input.endpoint.trim() === '') {
    throw new Error('[analytics-sdk] init: endpoint is required');
  }
  return {
    endpoint: input.endpoint.replace(/\/+$/, ''),
    sdkKey: input.sdkKey,
    session_inactivity_timeout_min: clamp(input.session_inactivity_timeout_min, 30, 1, 240),
    batch_max_events: clamp(input.batch_max_events, 50, 1, 500),
    flush_interval_ms: clamp(input.flush_interval_ms, 10_000, 1_000, 120_000),
    offline_queue_max_events: clamp(input.offline_queue_max_events, 10_000, 100, 100_000),
    retry_backoff_base_ms: clamp(input.retry_backoff_base_ms, 2_000, 100, 60_000),
    retry_backoff_max_ms: clamp(input.retry_backoff_max_ms, 300_000, 1_000, 3_600_000),
    storage: input.storage ?? 'auto',
    batch_max_bytes: clamp(input.batch_max_bytes, 60_000, 1_000, 500_000),
    compress: input.compress ?? 'auto',
    event_ttl_ms: clamp(input.event_ttl_ms, 82_800_000, 60_000, 86_400_000),
    debug: input.debug ?? false,
  };
}
