import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { connectPostgresOrNull } from '../testing/live-infra';
import { ConfigAdminService } from './config-admin.service';
import { GameConfigService } from './game-config.service';
import { DataExistsService } from './data-exists.service';
import { SecretCryptoService } from '../security/secret-crypto.service';
import { GameEntity } from '../database/entities/game.entity';
import { ConfigAuditEntity } from '../database/entities/config-audit.entity';
import { OperatorAccountEntity } from '../database/entities/operator-account.entity';
import { EventDayCountEntity } from '../database/entities/event-day-count.entity';

/**
 * Config admin write path (T-10.24/25/27/43/44) + R13 set-once hard-block +
 * infra-secret ciphertext (T-10.45), against LIVE Postgres. Proves:
 *   - out-of-contract value → rejected, NO write, NO audit (T-10.43);
 *   - unknown knob → rejected;
 *   - valid set → GAME.config written + exactly ONE CONFIG_AUDIT row stamped
 *     effective_from (forward-only, T-10.25/44/47);
 *   - infra secret (cold_storage_credentials) is CIPHERTEXT in GAME.config +
 *     REDACTED in the audit + REDACTED on read (T-10.45);
 *   - R13: reporting_offset edit is HARD-BLOCKED (platform-level + data-exists);
 *   - the hard-block refuses even with durable data present.
 * Skips when Postgres is unreachable.
 */

const MASTER = 'cfg-admin-master-key';

function cfg(): ConfigService {
  return { get: (k: string) => (k === 'SECRET_MASTER_KEY' ? MASTER : undefined) } as unknown as ConfigService;
}

describe('ConfigAdminService (live Postgres)', () => {
  let ds: DataSource | null = null;
  let admin: ConfigAdminService;
  let dataExists: DataExistsService;
  const GAME = `cfg-int-${Math.random().toString(36).slice(2)}`;
  let operatorId = '';

  beforeAll(async () => {
    ds = await connectPostgresOrNull();
    if (!ds) return;
    const gameConfig = new GameConfigService(ds, 0); // TTL=0 → no cache in tests
    dataExists = new DataExistsService(ds);
    admin = new ConfigAdminService(ds, gameConfig, dataExists, new SecretCryptoService(cfg()));

    await ds.getRepository(GameEntity).insert({
      gameId: GAME,
      name: 'Cfg Int Game',
      sdkKey: null,
      serverCredential: null,
      config: {},
      registeredAt: new Date(),
    });
    const op = await ds.getRepository(OperatorAccountEntity).save(
      ds.getRepository(OperatorAccountEntity).create({
        email: `cfg-op-${GAME}@example.com`,
        passwordHash: 'x',
        mfaTotpSecret: null,
        failedLoginCount: 0,
        lockedUntil: null,
        role: 'admin',
        createdAt: new Date(),
        disabledAt: null,
      }),
    );
    operatorId = op.operatorId;
  });

  afterAll(async () => {
    if (!ds) return;
    await ds.getRepository(EventDayCountEntity).delete({ gameId: GAME });
    await ds.getRepository(ConfigAuditEntity).delete({ gameId: GAME });
    await ds.getRepository(GameEntity).delete({ gameId: GAME });
    if (operatorId) await ds.getRepository(OperatorAccountEntity).delete({ operatorId });
    await ds.destroy();
  });

  it('rejects an out-of-contract value with NO write and NO audit (T-10.43)', async () => {
    if (!ds) return;
    const auditBefore = await ds.getRepository(ConfigAuditEntity).count({ where: { gameId: GAME } });
    // event_name_cap_per_game contract is int 1..100000; -5 is out of range.
    await expect(admin.set(GAME, 'event_name_cap_per_game', -5, operatorId)).rejects.toThrow(/invalid value/i);
    const auditAfter = await ds.getRepository(ConfigAuditEntity).count({ where: { gameId: GAME } });
    expect(auditAfter).toBe(auditBefore); // NO audit row
    const game = await ds.getRepository(GameEntity).findOneOrFail({ where: { gameId: GAME } });
    expect(game.config['event_name_cap_per_game']).toBeUndefined(); // NO write
  });

  it('rejects an unknown knob', async () => {
    if (!ds) return;
    await expect(admin.set(GAME, 'not_a_real_knob', 1, operatorId)).rejects.toThrow(/unknown config knob/i);
  });

  it('valid set writes GAME.config + exactly one CONFIG_AUDIT with effective_from (T-10.25/47)', async () => {
    if (!ds) return;
    const before = await ds
      .getRepository(ConfigAuditEntity)
      .count({ where: { gameId: GAME, configKey: 'top_n_events' } });
    const result = await admin.set(GAME, 'top_n_events', 25, operatorId);
    expect(result.effectiveFrom).toBeInstanceOf(Date);

    const game = await ds.getRepository(GameEntity).findOneOrFail({ where: { gameId: GAME } });
    expect(game.config['top_n_events']).toBe(25); // written

    const rows = await ds.getRepository(ConfigAuditEntity).find({ where: { gameId: GAME, configKey: 'top_n_events' } });
    expect(rows.length).toBe(before + 1); // exactly one new audit row
    const row = rows[rows.length - 1];
    expect(row?.newValue).toBe('25');
    expect(row?.effectiveFrom).toBeInstanceOf(Date);
    expect(row?.operatorId).toBe(operatorId);
  });

  it('records the OLD value on a subsequent change (forward-only trail)', async () => {
    if (!ds) return;
    await admin.set(GAME, 'top_n_events', 50, operatorId);
    const rows = await ds
      .getRepository(ConfigAuditEntity)
      .find({ where: { gameId: GAME, configKey: 'top_n_events' }, order: { changedAt: 'ASC' } });
    const latest = rows[rows.length - 1];
    expect(latest?.oldValue).toBe('25');
    expect(latest?.newValue).toBe('50');
  });

  it('infra secret is CIPHERTEXT in GAME.config, REDACTED in audit + on read (T-10.45)', async () => {
    if (!ds) return;
    const S3_KEY = 'AKIA-super-secret-s3-write-key';
    await admin.set(GAME, 'cold_storage_credentials', S3_KEY, operatorId);

    // Ciphertext in the DB column — a dump yields the v1. envelope, not plaintext.
    const game = await ds.getRepository(GameEntity).findOneOrFail({ where: { gameId: GAME } });
    const stored = game.config['cold_storage_credentials'];
    expect(typeof stored).toBe('string');
    expect(stored as string).not.toContain(S3_KEY);
    expect((stored as string).startsWith('v1.')).toBe(true);

    // Audit row never contains the plaintext or ciphertext.
    const row = await ds
      .getRepository(ConfigAuditEntity)
      .findOneOrFail({ where: { gameId: GAME, configKey: 'cold_storage_credentials' } });
    expect(row.newValue).not.toContain(S3_KEY);
    expect(row.newValue).toMatch(/redacted/i);

    // Read surface redacts too.
    const read = await admin.get(GAME);
    expect(read['cold_storage_credentials']).toMatch(/redacted/i);
    expect(JSON.stringify(read)).not.toContain(S3_KEY);
  });

  it('R13: reporting_offset edit is HARD-BLOCKED (platform-level set-once)', async () => {
    if (!ds) return;
    await expect(admin.set(GAME, 'reporting_offset', 210, operatorId)).rejects.toThrow(/set-once|platform-level/i);
    // No audit row was written for the blocked edit.
    const rows = await ds
      .getRepository(ConfigAuditEntity)
      .count({ where: { gameId: GAME, configKey: 'reporting_offset' } });
    expect(rows).toBe(0);
  });

  it('R13: the data-exists predicate flips true once a durable result row exists, and the block cites it', async () => {
    if (!ds) return;
    // Before: no durable data for THIS game — but the predicate is platform-wide.
    // Insert a durable EVENT_DAY_COUNT row → the predicate must report true.
    await ds.getRepository(EventDayCountEntity).insert({
      gameId: GAME,
      eventName: 'level_up',
      utcDay: '2026-07-18',
      count: '1',
    });
    expect(await dataExists.anyDurableDataExists()).toBe(true);

    // The edit is still refused; with data present the message cites the rebuild.
    await expect(admin.set(GAME, 'reporting_offset', 210, operatorId)).rejects.toThrow(
      /forbidden forward-rebuild|R13/i,
    );
  });

  it('rejects other platform-level knobs on the per-game write path', async () => {
    if (!ds) return;
    await expect(admin.set(GAME, 'operator_mfa_required', true, operatorId)).rejects.toThrow(/platform-level/i);
  });

  it('multi-game isolation: a write to one game never touches another (P12)', async () => {
    if (!ds) return;
    const OTHER = `${GAME}-other`;
    await ds.getRepository(GameEntity).insert({
      gameId: OTHER,
      name: 'Other Game',
      sdkKey: null,
      serverCredential: null,
      config: {},
      registeredAt: new Date(),
    });
    try {
      await admin.set(GAME, 'whale_min_payers', 7, operatorId);
      await admin.set(OTHER, 'whale_min_payers', 99, operatorId);

      const a = await ds.getRepository(GameEntity).findOneOrFail({ where: { gameId: GAME } });
      const b = await ds.getRepository(GameEntity).findOneOrFail({ where: { gameId: OTHER } });
      expect(a.config['whale_min_payers']).toBe(7);
      expect(b.config['whale_min_payers']).toBe(99);

      // Audit rows are per-game — OTHER's config change never lands in GAME's trail.
      const otherAudit = await ds
        .getRepository(ConfigAuditEntity)
        .find({ where: { gameId: OTHER, configKey: 'whale_min_payers' } });
      expect(otherAudit.length).toBe(1);
      const gameAudit = await admin.listAudit(GAME);
      expect(gameAudit.every((r) => r.gameId === GAME)).toBe(true);
    } finally {
      await ds.getRepository(ConfigAuditEntity).delete({ gameId: OTHER });
      await ds.getRepository(GameEntity).delete({ gameId: OTHER });
    }
  });
});
