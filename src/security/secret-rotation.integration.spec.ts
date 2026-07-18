import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { connectPostgresOrNull } from '../testing/live-infra';
import { SecretRotationService } from './secret-rotation.service';
import { SecretCryptoService } from './secret-crypto.service';
import { ConfigAdminService } from '../config/config-admin.service';
import { GameConfigService } from '../config/game-config.service';
import { DataExistsService } from '../config/data-exists.service';
import { MfaService } from '../operator/mfa.service';
import { GameEntity } from '../database/entities/game.entity';
import { OperatorAccountEntity } from '../database/entities/operator-account.entity';
import { ConfigAuditEntity } from '../database/entities/config-audit.entity';

/**
 * Master-key ROTATION bulk re-encrypt (T-10.22) against LIVE Postgres. Proves the
 * dual-key decrypt-old/encrypt-new pass migrates BOTH row classes (operator MFA
 * secrets + GAME.config infra secrets) from an OLD master key to a NEW one, that
 * after the pass the NEW key decrypts every row and the OLD key can no longer,
 * and that the pass is idempotent (a re-run re-encrypts nothing). Skips when
 * Postgres is unreachable.
 */

const OLD = 'rotation-old-master';
const NEW = 'rotation-new-master';

function cfg(key: string): ConfigService {
  return { get: (k: string) => (k === 'SECRET_MASTER_KEY' ? key : undefined) } as unknown as ConfigService;
}

describe('SecretRotationService (live Postgres)', () => {
  let ds: DataSource | null = null;
  let rotation: SecretRotationService;
  const GAME = `rot-int-${Math.random().toString(36).slice(2)}`;
  let operatorId = '';
  let rawTotpSecret = '';

  beforeAll(async () => {
    ds = await connectPostgresOrNull();
    if (!ds) return;
    rotation = new SecretRotationService(ds);

    // Seed an infra-secret config value encrypted under the OLD key.
    await ds.getRepository(GameEntity).insert({
      gameId: GAME,
      name: 'Rot Int Game',
      sdkKey: null,
      serverCredential: null,
      config: {},
      registeredAt: new Date(),
    });
    const op = await ds.getRepository(OperatorAccountEntity).save(
      ds.getRepository(OperatorAccountEntity).create({
        email: `rot-op-${GAME}@example.com`,
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

    // MFA secret encrypted under OLD.
    const mfaOld = new MfaService(new SecretCryptoService(cfg(OLD)));
    const enrol = mfaOld.enrol('rot-op@example.com');
    rawTotpSecret = enrol.secret;
    await ds.getRepository(OperatorAccountEntity).update({ operatorId }, { mfaTotpSecret: enrol.encryptedSecret });

    // Infra-secret config value encrypted under OLD via the write path.
    const adminOld = new ConfigAdminService(
      ds,
      new GameConfigService(ds, 0),
      new DataExistsService(ds),
      new SecretCryptoService(cfg(OLD)),
    );
    await adminOld.set(GAME, 'cold_storage_credentials', 'S3-KEY-encrypted-under-old', operatorId);
  });

  afterAll(async () => {
    if (!ds) return;
    await ds.getRepository(ConfigAuditEntity).delete({ gameId: GAME });
    await ds.getRepository(GameEntity).delete({ gameId: GAME });
    if (operatorId) await ds.getRepository(OperatorAccountEntity).delete({ operatorId });
    await ds.destroy();
  });

  it('re-encrypts operator MFA secret + infra config old→new; new decrypts, old cannot', async () => {
    if (!ds) return;
    const result = await rotation.reEncryptAll(OLD, NEW);
    expect(result.reEncrypted).toBeGreaterThanOrEqual(2); // mfa + cold_storage_credentials
    expect(result.skipped).toBe(0);

    const oldCrypto = new SecretCryptoService(cfg(OLD));
    const newCrypto = new SecretCryptoService(cfg(NEW));

    // MFA secret now under NEW.
    const op = await ds.getRepository(OperatorAccountEntity).findOneOrFail({ where: { operatorId } });
    expect(op.mfaTotpSecret).not.toBeNull();
    expect(newCrypto.decrypt(op.mfaTotpSecret as string)).toBe(rawTotpSecret);
    expect(() => oldCrypto.decrypt(op.mfaTotpSecret as string)).toThrow(); // old key retired

    // Infra config now under NEW.
    const game = await ds.getRepository(GameEntity).findOneOrFail({ where: { gameId: GAME } });
    const cipher = game.config['cold_storage_credentials'] as string;
    expect(newCrypto.decrypt(cipher)).toBe('S3-KEY-encrypted-under-old');
    expect(() => oldCrypto.decrypt(cipher)).toThrow();
  });

  it('is idempotent — a second pass re-encrypts nothing (already under the new key)', async () => {
    if (!ds) return;
    const again = await rotation.reEncryptAll(OLD, NEW);
    expect(again.reEncrypted).toBe(0);
    expect(again.alreadyCurrent).toBeGreaterThanOrEqual(2);
    expect(again.skipped).toBe(0);
  });

  it('refuses a no-op rotation (same key)', async () => {
    if (!ds) return;
    await expect(rotation.reEncryptAll(NEW, NEW)).rejects.toThrow(/must differ/i);
  });
});
