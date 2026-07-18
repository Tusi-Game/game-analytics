import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { connectPostgresOrNull } from '../testing/live-infra';
import { GdprAdminService } from './gdpr-admin.service';
import { ErasureService } from '../gdpr/erasure.service';
import { DsarService } from '../gdpr/dsar.service';
import { SubjectHashService } from '../security/subject-hash.service';
import { GameConfigService } from '../config/game-config.service';
import { NoSpineEnumerationPort, NoopTierADeletionPort, EmptyDsarExportPort } from '../gdpr/default-erasure.ports';
import { GameEntity } from '../database/entities/game.entity';
import { OperatorAccountEntity } from '../database/entities/operator-account.entity';
import { ErasureLedgerEntity } from '../database/entities/erasure-ledger.entity';
import { GdprRequestAuditEntity } from '../database/entities/gdpr-request-audit.entity';

/**
 * GDPR admin surface (T-10.29/30/31/32/46) against LIVE Postgres. Proves:
 *   - operator-verified erasure trigger → ErasureService job runs + attestation
 *     row recorded (keyed subject_ref, never plaintext user_id);
 *   - DSAR-access trigger → assembled export incl. the Art. 11 scope_note;
 *   - awaiting_seal stuck-flag surface lists a parked erasure request (T-10.30);
 *   - a missing attestation is refused (over-trusted-surface guard).
 * Skips when Postgres is unreachable.
 */

function cfg(): ConfigService {
  return {
    get: (k: string) => (k === 'SECRET_MASTER_KEY' ? 'gdpr-admin-master' : undefined),
  } as unknown as ConfigService;
}

describe('GdprAdminService (live Postgres)', () => {
  let ds: DataSource | null = null;
  let gdpr: GdprAdminService;
  let subjectHash: SubjectHashService;
  const GAME = `gdpr-int-${Math.random().toString(36).slice(2)}`;
  let operatorId = '';

  beforeAll(async () => {
    ds = await connectPostgresOrNull();
    if (!ds) return;

    subjectHash = new SubjectHashService(cfg());
    const gameConfig = new GameConfigService(ds, 0);
    const erasure = new ErasureService(
      ds,
      subjectHash,
      gameConfig,
      new NoSpineEnumerationPort(),
      new NoopTierADeletionPort(),
    );
    const dsar = new DsarService(ds, new EmptyDsarExportPort());
    gdpr = new GdprAdminService(ds, erasure, dsar, subjectHash);

    await ds.getRepository(GameEntity).insert({
      gameId: GAME,
      name: 'Gdpr Int Game',
      sdkKey: null,
      serverCredential: null,
      config: {},
      registeredAt: new Date(),
    });
    const op = await ds.getRepository(OperatorAccountEntity).save(
      ds.getRepository(OperatorAccountEntity).create({
        email: `gdpr-op-${GAME}@example.com`,
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
    await ds.getRepository(GdprRequestAuditEntity).delete({ gameId: GAME });
    await ds.getRepository(ErasureLedgerEntity).delete({ gameId: GAME });
    await ds.getRepository(GameEntity).delete({ gameId: GAME });
    if (operatorId) await ds.getRepository(OperatorAccountEntity).delete({ operatorId });
    await ds.destroy();
  });

  it('erasure trigger runs the job + records an attestation (keyed subject_ref)', async () => {
    if (!ds) return;
    const userId = 'player-erase-1';
    const result = await gdpr.triggerErasure({
      gameId: GAME,
      userId,
      attestation: 'Verified by studio support ticket #4242',
      operatorId,
    });
    // Default ports → all-sealed vacuously → executed.
    expect(result.status).toBe('executed');

    const audits = await ds.getRepository(GdprRequestAuditEntity).find({ where: { gameId: GAME, kind: 'erasure' } });
    expect(audits.length).toBe(1);
    const audit = audits[0];
    expect(audit?.operatorId).toBe(operatorId);
    expect(audit?.attestation).toMatch(/#4242/);
    // subject_ref is the keyed hash, NEVER the plaintext user_id.
    expect(audit?.subjectRef).toBe(subjectHash.subjectRef(GAME, userId));
    expect(audit?.subjectRef).not.toContain(userId);
  });

  it('DSAR trigger returns the export incl. the Art. 11 scope_note + audits it', async () => {
    if (!ds) return;
    const userId = 'player-dsar-1';
    const export_ = await gdpr.triggerDsar({
      gameId: GAME,
      userId,
      attestation: 'Verified DSAR request, ID check on file',
      operatorId,
    });
    expect(export_.game_id).toBe(GAME);
    expect(export_.user_id).toBe(userId);
    expect(export_.scope_note).toMatch(/Art\. 11|Recital 26/i);

    const audits = await ds
      .getRepository(GdprRequestAuditEntity)
      .find({ where: { gameId: GAME, kind: 'dsar_access' } });
    expect(audits.length).toBe(1);
    expect(audits[0]?.outcome).toBe('assembled');
  });

  it('awaiting_seal stuck-flag surfaces a parked erasure request (T-10.30)', async () => {
    if (!ds) return;
    // Seed a parked request (as the erasure job would when a day stays unsealed).
    await ds.getRepository(ErasureLedgerEntity).insert({
      gameId: GAME,
      requestId: 'stuck-req-1',
      requestedAt: new Date(),
      status: 'awaiting_seal',
      executedAt: null,
      subjectRef: subjectHash.subjectRef(GAME, 'still-active-player'),
    });
    const stuck = await gdpr.listStuckAwaitingSeal(GAME);
    expect(stuck.some((r) => r.requestId === 'stuck-req-1' && r.status === 'awaiting_seal')).toBe(true);
    // Cross-game listing also includes it (still one game per row, P12).
    const all = await gdpr.listStuckAwaitingSeal();
    expect(all.some((r) => r.gameId === GAME && r.requestId === 'stuck-req-1')).toBe(true);
  });

  it('refuses a trigger with a missing attestation (over-trusted-surface guard)', async () => {
    if (!ds) return;
    await expect(gdpr.triggerErasure({ gameId: GAME, userId: 'x', attestation: '   ', operatorId })).rejects.toThrow(
      /attestation/i,
    );
  });
});
