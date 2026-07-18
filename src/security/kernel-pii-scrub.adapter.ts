/**
 * Kernel PII-scrub adapter (T-00.86) — binds {@link PiiScrubService} to the
 * kernel's {@link PiiScrubPort} seam (step 3 / pre-step-4). Reads the per-game
 * `pii_prop_denylist` override from GAME.config (forward-only) and merges it onto
 * the shipped default denylist, then scrubs the props before the raw append.
 *
 * The catalog PII-warning surface (011) is out of scope here; a scrubbed
 * observation is logged so an operator can see it happened. The scrub itself is
 * the security-critical part and runs unconditionally in production.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { PiiScrubPort } from '../workers/kernel/ingest-kernel';
import { PiiScrubService } from './pii-scrub.service';
import { GameConfigService } from '../config/game-config.service';

@Injectable()
export class KernelPiiScrubAdapter implements PiiScrubPort {
  private readonly logger = new Logger(KernelPiiScrubAdapter.name);

  constructor(
    private readonly scrubber: PiiScrubService,
    private readonly gameConfig: GameConfigService,
  ) {}

  async scrubProps(gameId: string, props: Record<string, unknown>): Promise<Record<string, unknown>> {
    const extra = await this.readPerGameDenylist(gameId);
    const result = this.scrubber.scrub(props, extra);
    if (result.scrubbed) {
      // Catalog PII-warning signal (ops-envelope §9). 011 surfaces it in the UI;
      // here it is an operational log so the observation is not silent.
      this.logger.warn(
        `[pii] scrubbed props for game=${gameId} droppedKeys=[${result.droppedKeys.join(',')}] (value-redactions applied)`,
      );
    }
    return result.props;
  }

  /** Read the per-game `pii_prop_denylist` array from GAME.config (if any). */
  private async readPerGameDenylist(gameId: string): Promise<string[]> {
    const config = await this.gameConfig.getConfig(gameId);
    const raw = config['pii_prop_denylist'];
    if (Array.isArray(raw)) {
      return raw.filter((k): k is string => typeof k === 'string');
    }
    return [];
  }
}
