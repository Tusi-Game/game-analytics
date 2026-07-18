/**
 * Erasure + DSAR against LIVE Postgres (T-00.94, ops-envelope §7/§9).
 *
 * The unit spec proves the contract with fakes; this proves it against REAL SQL:
 *  - the ledger row lands with the keyed-hash subject_ref (no plaintext user_id
 *    anywhere in the row);
 *  - the destructive pass deletes the subject's IDENTITY_EDGE rows;
 *  - the job is idempotent — a re-run is a no-op (still `executed`, no error);
 *  - DSAR assembles the subject's identity edges from real rows.
 * Skips when the stack is unreachable.
 */

import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { connectPostgresOrNull } from '../testing/live-infra';
import { ErasureService } from './erasure.service';
import { DsarService } from './dsar.service';
import { SubjectHashService } from '../security/subject-hash.service';
import { ErasureLedgerEntity } from '../database/entities/erasure-ledger.entity';
import { IdentityEdgeEntity } from '../database/entities/identity-edge.entity';
import type { GameConfigService } from '../config/game-config.service';
import { NoSpineEnumerationPort, NoopTierADeletionPort, EmptyDsarExportPort } from './default-erasure.ports';

const cfg = { get: () => 'live-test-master' } as unknown as ConfigService;
const gameConfig = { getString: async () => undefined } as unknown as GameConfigService;

describe('Erasure + DSAR (live Postgres)', () => {
  let ds: DataSource | null = null;
  let erasure: ErasureService;
  let dsar: DsarService;
  let subjectHash: SubjectHashService;
  const GAME = `erase-it-${Math.random().toString(36).slice(2)}`;
  const USER = 'user-to-erase-42';

  beforeAll(async () => {
    ds = await connectPostgresOrNull();
    if (!ds) return;
    subjectHash = new SubjectHashService(cfg);
    erasure = new ErasureService(
      ds,
      subjectHash,
      gameConfig,
      new NoSpineEnumerationPort(),
      new NoopTierADeletionPort(),
    );
    dsar = new DsarService(ds, new EmptyDsarExportPort());

    await ds.getRepository(IdentityEdgeEntity).insert([
      { gameId: GAME, anonId: 'anon-1', userId: USER, firstLinkedAt: new Date() },
      { gameId: GAME, anonId: 'anon-2', userId: USER, firstLinkedAt: new Date() },
      { gameId: GAME, anonId: 'anon-3', userId: 'someone-else', firstLinkedAt: new Date() },
    ]);
  });

  afterAll(async () => {
    if (ds) {
      await ds.getRepository(ErasureLedgerEntity).delete({ gameId: GAME });
      await ds.getRepository(IdentityEdgeEntity).delete({ gameId: GAME });
      await ds.destroy();
    }
  });

  it('DSAR export lists the subject edges before erasure', async () => {
    if (!ds) return;
    const out = await dsar.assemble(GAME, USER);
    expect(out.identity_edges).toHaveLength(2); // anon-1, anon-2 (not someone-else)
  });

  it('erasure writes a keyed-hash subject_ref (no plaintext) + deletes IDENTITY_EDGE', async () => {
    if (!ds) return;
    const res = await erasure.erase({ gameId: GAME, requestId: 'req-1', userId: USER });
    expect(res.status).toBe('executed');

    const row = await ds.getRepository(ErasureLedgerEntity).findOne({ where: { gameId: GAME, requestId: 'req-1' } });
    expect(row).not.toBeNull();
    expect(row!.subjectRef).toBe(subjectHash.subjectRef(GAME, USER));
    expect(row!.subjectRef).not.toContain(USER); // NEVER plaintext

    // The subject's edges are gone; the other user's edge survives.
    const remaining = await ds.getRepository(IdentityEdgeEntity).find({ where: { gameId: GAME } });
    expect(remaining.every((e) => e.userId !== USER)).toBe(true);
    expect(remaining.some((e) => e.userId === 'someone-else')).toBe(true);
  });

  it('is idempotent — a second run stays executed and does not error', async () => {
    if (!ds) return;
    const again = await erasure.erase({ gameId: GAME, requestId: 'req-1', userId: USER });
    expect(again.status).toBe('executed');
    const rows = await ds.getRepository(ErasureLedgerEntity).find({ where: { gameId: GAME, requestId: 'req-1' } });
    expect(rows).toHaveLength(1); // no duplicate ledger row
  });
});
