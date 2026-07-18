/**
 * Shared panel view-model formatting helpers (design §4). Controllers use these
 * to shape read-service outputs into template-ready strings; Nunjucks stays
 * autoescaped and logic-light. Pure — no I/O.
 */

import type { Trend } from './dashboard/trend';

/** A rendered KPI card (partial: metric-card.njk). */
export interface MetricCard {
  label: string;
  /** Pre-formatted display value (e.g. "1,247", "$0.04", "14.8%", "N/A"). */
  value: string;
  trend?: Trend;
  /** True when the figure includes today (amber provisional badge). */
  provisional?: boolean;
}

/** A serialized Chart.js config for a chart-fragment (data-chart-config). */
export interface ChartConfig {
  type: string;
  data: unknown;
  options?: unknown;
}

/** Format an integer/large number with thousands separators; "N/A" for null. */
export function fmtCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'N/A';
  }
  return Math.round(value).toLocaleString('en-US');
}

/** Compact large numbers (45231 → "45.2K", 8_420_000 → "8.4M"). "N/A" for null. */
export function fmtCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'N/A';
  }
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return `${Math.round(value)}`;
}

/** Format a normalized money amount as "$X.XX"; "N/A" for null. */
export function fmtMoney(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'N/A';
  }
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Format a fraction (0..1) as a percentage "14.8%"; "N/A" for null. */
export function fmtPercent(fraction: number | null, decimals = 1): string {
  if (fraction === null || !Number.isFinite(fraction)) {
    return 'N/A';
  }
  return `${(fraction * 100).toFixed(decimals)}%`;
}

/**
 * Format a duration in ms as "12m 24s" (sub-hour) or "2h 15m" (spec §2.7).
 * "N/A" for null / non-finite.
 */
export function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return 'N/A';
  }
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  return `${m}m ${s}s`;
}
