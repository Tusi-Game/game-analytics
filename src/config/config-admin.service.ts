/**
 * Config write path (T-10.24/25/27) — the FORWARD-ONLY config administration
 * service. GameConfigService is READ-ONLY; this is the sole config WRITER (P9).
 *
 * set(gameId, key, value, operator):
 *   1. the knob must be an administered knob (config-contract registry) — an
 *      unknown key is rejected (NO write, NO audit);
 *   2. platform-level knobs (reporting_offset, operator_*, worker_config_cache_*)
 *      are env-sourced, NOT per-game GAME.config writes → rejected here;
 *   3. reporting_offset carries the R13 SET-ONCE hard-block — rejected outright
 *      on the per-game path (it is platform-level) AND, defensively, if any
 *      durable data exists (DataExistsService), so the guard is proven testable;
 *   4. the value is validated against the knob's contract — an out-of-contract
 *      value is rejected (NO write, NO audit, T-10.43);
 *   5. reversible INFRA SECRETS (cold_storage_credentials, fx_table material) are
 *      envelope-encrypted (SecretCryptoService) BEFORE the GAME.config write, so a
 *      DB dump yields ciphertext (P13/FR-029) — they are NEVER plaintext in
 *      GAME.config;
 *   6. on a valid set: write GAME.config (jsonb merge) + append ONE CONFIG_AUDIT
 *      row stamped `effective_from` = the processing-time watermark (now) at which
 *      workers begin honoring it. FORWARD-ONLY — never retroactive, never sealed.
 *      Exactly ONE audit row per write (T-10.47).
 *   7. invalidate the read cache so a subsequent read observes the new value.
 *
 * The CONFIG_AUDIT `old_value`/`new_value` are text; infra-secret values are
 * recorded as a REDACTED marker (never the plaintext or ciphertext) so the audit
 * trail does not leak a secret.
 */

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { GameEntity } from '../database/entities/game.entity';
import { ConfigAuditEntity } from '../database/entities/config-audit.entity';
import { GameConfigService } from './game-config.service';
import { DataExistsService } from './data-exists.service';
import { SecretCryptoService } from '../security/secret-crypto.service';
import { getKnobContract, type KnobContract } from './config-contract';
import { validateValue } from './config-validator';

/**
 * Reversible infra-secret knobs whose value is envelope-encrypted at rest (never
 * plaintext in GAME.config, P13/FR-029). Their audit trail records only a
 * redacted marker. `mfa_totp_secret` is on OPERATOR_ACCOUNT, not GAME.config, so
 * it is not here — but it shares the same SecretCryptoService envelope.
 */
export const INFRA_SECRET_KNOBS: ReadonlySet<string> = new Set(['cold_storage_credentials', 'fx_table']);

/** Marker written to CONFIG_AUDIT in place of a secret's real value. */
const REDACTED = '[redacted-infra-secret]';

export interface ConfigSetResult {
  gameId: string;
  key: string;
  /** The processing-time watermark stamped on the CONFIG_AUDIT row (forward-only). */
  effectiveFrom: Date;
  auditId: string;
}

export interface ConfigAuditRow {
  auditId: string;
  gameId: string;
  operatorId: string;
  configKey: string;
  oldValue: string | null;
  newValue: string;
  changedAt: Date;
  effectiveFrom: Date;
}

@Injectable()
export class ConfigAdminService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly gameConfig: GameConfigService,
    private readonly dataExists: DataExistsService,
    private readonly crypto: SecretCryptoService,
  ) {}

  /**
   * Read the administered config for a game: the raw GAME.config with infra
   * secrets REDACTED (never returns a stored secret's ciphertext/plaintext).
   */
  async get(gameId: string): Promise<Record<string, unknown>> {
    await this.assertGameExists(gameId);
    const config = await this.gameConfig.getConfig(gameId);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config)) {
      out[k] = INFRA_SECRET_KNOBS.has(k) ? REDACTED : v;
    }
    return out;
  }

  /**
   * Forward-only config set. Validates against the knob contract, hard-blocks
   * platform/set-once knobs, envelope-encrypts infra secrets, writes GAME.config,
   * and appends exactly one CONFIG_AUDIT row. Rejects (no write / no audit) on
   * any contract violation.
   */
  async set(gameId: string, key: string, value: unknown, operatorId: string): Promise<ConfigSetResult> {
    await this.assertGameExists(gameId);

    const contract = getKnobContract(key);
    if (!contract) {
      throw new BadRequestException(`unknown config knob "${key}" (not in the administered inventory)`);
    }

    // Platform-level knobs are env-sourced, not per-game GAME.config writes.
    if (contract.scope === 'platform') {
      await this.rejectPlatformKnob(key, contract);
    }

    // Validate the value against the contract BEFORE any write or audit.
    const check = validateValue(contract.contract, value);
    if (!check.ok) {
      throw new BadRequestException(`invalid value for "${key}": ${check.reason}`);
    }

    // Read the prior value (for the audit trail + jsonb merge).
    const priorConfig = await this.gameConfig.getConfig(gameId);
    const priorRaw = priorConfig[key];

    // Envelope-encrypt reversible infra secrets before persisting.
    const storedValue = this.storedValueFor(key, value);

    const now = new Date();
    const auditId = randomUUID();

    // Single transaction: jsonb merge on GAME.config + append CONFIG_AUDIT.
    await this.dataSource.transaction(async (manager) => {
      // jsonb concat merges/overwrites the single key without clobbering siblings.
      await manager
        .getRepository(GameEntity)
        .createQueryBuilder()
        .update(GameEntity)
        .set({ config: () => `config || :patch::jsonb` })
        .where('game_id = :gameId', { gameId })
        .setParameter('patch', JSON.stringify({ [key]: storedValue }))
        .execute();

      await manager.getRepository(ConfigAuditEntity).insert({
        gameId,
        auditId,
        operatorId,
        configKey: key,
        oldValue: this.auditValue(key, priorRaw, /* prior */ true),
        newValue: this.auditValue(key, value, /* prior */ false) ?? REDACTED,
        changedAt: now,
        effectiveFrom: now,
      });
    });

    // Drop the read cache so workers/readers observe the new value on next read.
    this.gameConfig.invalidate(gameId);

    return { gameId, key, effectiveFrom: now, auditId };
  }

  /** List the CONFIG_AUDIT trail for a game, newest first (T-10.27/35). */
  async listAudit(gameId: string, limit = 200): Promise<ConfigAuditRow[]> {
    await this.assertGameExists(gameId);
    const rows = await this.dataSource
      .getRepository(ConfigAuditEntity)
      .find({ where: { gameId }, order: { changedAt: 'DESC' }, take: Math.min(Math.max(1, limit), 1000) });
    return rows.map((r) => ({
      auditId: r.auditId,
      gameId: r.gameId,
      operatorId: r.operatorId,
      configKey: r.configKey,
      oldValue: r.oldValue,
      newValue: r.newValue,
      changedAt: r.changedAt,
      effectiveFrom: r.effectiveFrom,
    }));
  }

  // ── internals ───────────────────────────────────────────────────────────

  /**
   * Reject a platform-level knob on the per-game write path. For reporting_offset
   * this is the R13 SET-ONCE hard-block: it is refused outright as a per-game
   * write, and the data-exists predicate is consulted so the guard's teeth are
   * demonstrably exercised (P8) — either condition refuses the edit.
   */
  private async rejectPlatformKnob(key: string, contract: KnobContract): Promise<void> {
    if (key === 'reporting_offset') {
      const dataExists = await this.dataExists.anyDurableDataExists();
      throw new ForbiddenException(
        `reporting_offset is a platform-level, SET-ONCE knob (env REPORTING_OFFSET). ` +
          `It cannot be edited via the admin config API` +
          (dataExists
            ? ' — durable data already exists, so changing it is a forbidden forward-rebuild (R13/P8).'
            : '.'),
      );
    }
    throw new ForbiddenException(
      `"${key}" is a platform-level knob (${contract.owner}); it is configured via environment, ` +
        `not the per-game admin config API.`,
    );
  }

  /** Envelope-encrypt a reversible infra secret; pass other values through. */
  private storedValueFor(key: string, value: unknown): unknown {
    if (!INFRA_SECRET_KNOBS.has(key)) {
      return value;
    }
    // Serialize non-string secret material (e.g. an fx_table object) to a string
    // before encrypting; the ciphertext is what lands in GAME.config.
    const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
    return this.crypto.encrypt(plaintext);
  }

  /**
   * The value recorded in CONFIG_AUDIT. Infra secrets are redacted (never the
   * plaintext or ciphertext). Non-secret values are JSON-serialized to text.
   */
  private auditValue(key: string, value: unknown, prior: boolean): string | null {
    if (value === undefined) {
      return prior ? null : REDACTED;
    }
    if (INFRA_SECRET_KNOBS.has(key)) {
      return REDACTED;
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  private async assertGameExists(gameId: string): Promise<void> {
    const exists = await this.dataSource
      .getRepository(GameEntity)
      .findOne({ where: { gameId }, select: { gameId: true } });
    if (!exists) {
      throw new NotFoundException(`game "${gameId}" not found`);
    }
  }
}
