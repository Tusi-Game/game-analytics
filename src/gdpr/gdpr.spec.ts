/**
 * GDPR erasure + DSAR unit tests (T-00.94, ops-envelope §7/§9).
 *
 * Proves the erasure CONTRACT with fake repositories (no live Postgres):
 *  - ledger written with a per-game KEYED-HASH subject_ref, NEVER the plaintext
 *    user_id (DARK-SPOT: no PII in Postgres);
 *  - idempotent: a second run on an `executed` request is a no-op (no re-delete);
 *  - parks `awaiting_seal` when a spine day is unsealed (destructive pass deferred);
 *  - destructive pass deletes the 002-owned IDENTITY_EDGE + delegates tier-a;
 *  - DSAR assembles a machine-readable export (Art. 11 scope note present).
 */

import { ConfigService } from '@nestjs/config';
import { ErasureService } from './erasure.service';
import { DsarService } from './dsar.service';
import { SubjectHashService } from '../security/subject-hash.service';
import type { GameConfigService } from '../config/game-config.service';
import type { SpineEnumerationPort, TierADeletionPort, DsarExportPort } from './erasure.ports';
import type { ErasureLedgerEntity } from '../database/entities/erasure-ledger.entity';

/** Minimal in-memory repository behind DataSource.getRepository(). */
class FakeRepo<T extends Record<string, unknown>> {
  readonly rows: T[] = [];
  readonly deleted: Array<Record<string, unknown>> = [];

  async findOne(opts: { where: Record<string, unknown> }): Promise<T | null> {
    return this.rows.find((r) => this.matches(r, opts.where)) ?? null;
  }
  async find(opts?: { where?: Record<string, unknown> }): Promise<T[]> {
    if (!opts?.where) return [...this.rows];
    return this.rows.filter((r) => this.matches(r, opts.where!));
  }
  async insert(row: T): Promise<void> {
    this.rows.push({ ...row });
  }
  async update(where: Record<string, unknown>, patch: Partial<T>): Promise<void> {
    for (const r of this.rows) {
      if (this.matches(r, where)) Object.assign(r, patch);
    }
  }
  async delete(where: Record<string, unknown>): Promise<void> {
    this.deleted.push(where);
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      if (this.matches(this.rows[i]!, where)) this.rows.splice(i, 1);
    }
  }
  private matches(row: T, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([k, v]) => row[k] === v);
  }
}

class FakeDataSource {
  constructor(
    private readonly ledger: FakeRepo<Record<string, unknown>>,
    private readonly edges: FakeRepo<Record<string, unknown>>,
  ) {}
  getRepository(entity: { name?: string }): unknown {
    // Distinguish by the entity class name.
    return entity.name === 'ErasureLedgerEntity' ? this.ledger : this.edges;
  }
}

class SpyTierA implements TierADeletionPort {
  readonly calls: Array<{ gameId: string; userId: string; purchaseMode: string }> = [];
  async deleteSpineFamily(input: {
    gameId: string;
    userId: string;
    days: string[];
    purchaseMode: 'detach' | 'delete';
  }): Promise<void> {
    this.calls.push({ gameId: input.gameId, userId: input.userId, purchaseMode: input.purchaseMode });
  }
}

class FakeSpine implements SpineEnumerationPort {
  constructor(private readonly result: { days: string[]; allSealed: boolean }) {}
  async enumerateDays(): Promise<{ days: string[]; allSealed: boolean }> {
    return this.result;
  }
}

function gameConfigStub(mode?: string): GameConfigService {
  return { getString: async () => mode } as unknown as GameConfigService;
}

function build(spine: { days: string[]; allSealed: boolean }, mode?: string) {
  const ledger = new FakeRepo<Record<string, unknown>>();
  const edges = new FakeRepo<Record<string, unknown>>();
  const ds = new FakeDataSource(ledger, edges);
  const subjectHash = new SubjectHashService({ get: () => 'master' } as unknown as ConfigService);
  const tierA = new SpyTierA();
  const svc = new ErasureService(ds as never, subjectHash, gameConfigStub(mode), new FakeSpine(spine), tierA);
  return { svc, ledger, edges, tierA, subjectHash };
}

describe('ErasureService (four-tier, ops-envelope §7)', () => {
  it('writes the ledger with a keyed-hash subject_ref (NEVER plaintext user_id)', async () => {
    const { svc, ledger, subjectHash } = build({ days: [], allSealed: true });
    const res = await svc.erase({ gameId: 'g1', requestId: 'r1', userId: 'alice@example.com' });

    expect(res.status).toBe('executed');
    const row = ledger.rows[0] as unknown as ErasureLedgerEntity;
    // subject_ref is the keyed hash, and the plaintext user_id appears nowhere.
    expect(row.subjectRef).toBe(subjectHash.subjectRef('g1', 'alice@example.com'));
    expect(row.subjectRef).not.toContain('alice');
    expect(JSON.stringify(ledger.rows)).not.toContain('alice@example.com');
  });

  it('is idempotent — a second run on an executed request does not re-delete', async () => {
    const { svc, edges } = build({ days: [], allSealed: true });
    edges.rows.push({ gameId: 'g1', anonId: 'a1', userId: 'u1', firstLinkedAt: new Date() });

    await svc.erase({ gameId: 'g1', requestId: 'r1', userId: 'u1' });
    expect(edges.rows).toHaveLength(0); // deleted on first run
    const deletesAfterFirst = edges.deleted.length;

    const second = await svc.erase({ gameId: 'g1', requestId: 'r1', userId: 'u1' });
    expect(second.status).toBe('executed');
    // No new delete issued on the idempotent re-run.
    expect(edges.deleted.length).toBe(deletesAfterFirst);
  });

  it('parks awaiting_seal when a spine day is unsealed (destructive pass deferred)', async () => {
    const { svc, ledger, edges, tierA } = build({ days: ['2026-07-18'], allSealed: false });
    edges.rows.push({ gameId: 'g1', anonId: 'a1', userId: 'u1', firstLinkedAt: new Date() });

    const res = await svc.erase({ gameId: 'g1', requestId: 'r1', userId: 'u1' });
    expect(res.status).toBe('awaiting_seal');
    expect((ledger.rows[0] as { status: string }).status).toBe('awaiting_seal');
    // Nothing deleted while parked.
    expect(edges.rows).toHaveLength(1);
    expect(tierA.calls).toHaveLength(0);
  });

  it('destructive pass deletes IDENTITY_EDGE + delegates tier-a with the purchase mode', async () => {
    const { svc, edges, tierA } = build({ days: ['2026-07-18'], allSealed: true }, 'delete');
    edges.rows.push({ gameId: 'g1', anonId: 'a1', userId: 'u1', firstLinkedAt: new Date() });
    edges.rows.push({ gameId: 'g1', anonId: 'a2', userId: 'u1', firstLinkedAt: new Date() });

    await svc.erase({ gameId: 'g1', requestId: 'r1', userId: 'u1' });
    expect(edges.rows).toHaveLength(0);
    expect(tierA.calls).toHaveLength(1);
    expect(tierA.calls[0]!.purchaseMode).toBe('delete');
  });

  it('defaults the purchase mode to detach', async () => {
    const { svc, tierA } = build({ days: [], allSealed: true });
    await svc.erase({ gameId: 'g1', requestId: 'r1', userId: 'u1' });
    expect(tierA.calls[0]!.purchaseMode).toBe('detach');
  });
});

describe('DsarService (Art. 15/20, read-only)', () => {
  it('assembles an export with the Art. 11 scope note + identity edges', async () => {
    const ledger = new FakeRepo<Record<string, unknown>>();
    const edges = new FakeRepo<Record<string, unknown>>();
    edges.rows.push({ gameId: 'g1', anonId: 'a1', userId: 'u1', firstLinkedAt: new Date('2026-07-18T00:00:00Z') });
    const ds = new FakeDataSource(ledger, edges);
    const exporter: DsarExportPort = { assembleSpineExport: async () => ({ probe: true }) };
    const svc = new DsarService(ds as never, exporter);

    const out = await svc.assemble('g1', 'u1');
    expect(out.game_id).toBe('g1');
    expect(out.user_id).toBe('u1');
    expect(out.scope_note).toContain('Art. 11');
    expect(out.identity_edges).toHaveLength(1);
    expect(out.identity_edges[0]!.anon_id).toBe('a1');
    expect(out.spine).toEqual({ probe: true });
  });
});
