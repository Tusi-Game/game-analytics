/**
 * PanelConfigService (T-11.5) — the four platform-level panel knobs (spec §6),
 * read at render time so every panel view shares the same branding + live-poll
 * cadence. These knobs are PLATFORM-level (not per-game) and are NOT in the
 * per-game CONFIG_CONTRACTS registry (which would let a per-game admin edit them);
 * they are sourced from environment with the spec's defaults. Surfacing them here
 * (env-backed, read-only in the panel) matches the config-contract rule that
 * platform knobs come from env, never a per-game GAME.config write.
 *
 *   panel_live_poll_interval_sec  30       HTMX live-counter poll cadence
 *   panel_chart_color_primary     #4f46e5  primary chart color (white-label)
 *   panel_logo_url                /img/logo.svg
 *   panel_title                   Game Analytics
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** The render-time panel branding + polling settings. */
export interface PanelSettings {
  livePollIntervalSec: number;
  chartColorPrimary: string;
  logoUrl: string;
  panelTitle: string;
  /** Whether cookies should carry the Secure attribute (TLS on). */
  cookieSecure: boolean;
}

@Injectable()
export class PanelConfigService {
  constructor(private readonly config: ConfigService) {}

  settings(): PanelSettings {
    const poll = this.config.get<number>('PANEL_LIVE_POLL_INTERVAL_SEC');
    return {
      livePollIntervalSec: typeof poll === 'number' && poll > 0 ? poll : 30,
      chartColorPrimary: this.config.get<string>('PANEL_CHART_COLOR_PRIMARY') ?? '#4f46e5',
      logoUrl: this.config.get<string>('PANEL_LOGO_URL') ?? '/img/logo.svg',
      panelTitle: this.config.get<string>('PANEL_TITLE') ?? 'Game Analytics',
      // Secure cookies when explicitly enabled OR in production (behind TLS proxy).
      cookieSecure:
        this.config.get<string>('PANEL_COOKIE_SECURE') === '1' || this.config.get<string>('NODE_ENV') === 'production',
    };
  }

  /** The primary chart color, for Chart.js configs built server-side. */
  chartColor(): string {
    return this.settings().chartColorPrimary;
  }
}
