import { Redis } from 'ioredis';
import { RehydrateService, SEEDED_MARKER_FIELD, DurableFloor } from './rehydrate';

/**
 * Minimal in-memory Redis fake modelling exactly the commands RehydrateService
 * uses, with faithful semantics for the properties under test:
 *   - HSETNX: set only if the field is ABSENT (first-write-wins). A pre-existing
 *     value — e.g. a live HINCRBY — is NEVER overwritten.
 *   - HSET / HGET: plain field set / read.
 *   - SADD: union into a set (idempotent).
 *   - MULTI/EXEC: commands buffered on the pipeline apply in insertion order on
 *     EXEC — so a marker HSET queued last lands after every seed.
 *
 * This is deliberately hand-rolled (no ioredis-mock dependency) so the ST1
 * double-seed race and ST2 half-seed guard are exercised deterministically.
 */
class FakeRedis {
  private hashes = new Map<string, Map<string, string>>();
  private sets = new Map<string, Set<string>>();

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }

  hsetnxSync(key: string, field: string, value: string): void {
    const h = this.hash(key);
    if (!h.has(field)) h.set(field, value);
  }

  hsetSync(key: string, field: string, value: string): void {
    this.hash(key).set(field, value);
  }

  hincrbySync(key: string, field: string, by: number): string {
    const h = this.hash(key);
    const next = Number(h.get(field) ?? '0') + by;
    h.set(field, String(next));
    return String(next);
  }

  saddSync(key: string, members: string[]): void {
    let s = this.sets.get(key);
    if (!s) {
      s = new Set();
      this.sets.set(key, s);
    }
    for (const m of members) s.add(m);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  hgetSync(key: string, field: string): string | null {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  smembersSync(key: string): string[] {
    return [...(this.sets.get(key) ?? new Set<string>())];
  }

  /** MULTI returns a pipeline that buffers ops and applies them in order on exec. */
  multi(): FakePipeline {
    return new FakePipeline(this);
  }
}

class FakePipeline {
  private ops: Array<() => void> = [];
  constructor(private readonly db: FakeRedis) {}

  hsetnx(key: string, field: string, value: string): this {
    this.ops.push(() => this.db.hsetnxSync(key, field, value));
    return this;
  }

  hset(key: string, field: string, value: string): this {
    this.ops.push(() => this.db.hsetSync(key, field, value));
    return this;
  }

  sadd(key: string, ...members: string[]): this {
    this.ops.push(() => this.db.saddSync(key, members));
    return this;
  }

  async exec(): Promise<void> {
    for (const op of this.ops) op();
  }
}

function makeService(fake: FakeRedis): RehydrateService {
  // The fake structurally satisfies only the subset RehydrateService touches.
  return new RehydrateService(fake as unknown as Redis);
}

describe('RehydrateService (foundation §2.3 — rehydrate + seeded marker, P10)', () => {
  const KEY = 'game-42:cnt:2026-07-18';

  it('seeds fields from the durable FLOOR via HSETNX (not 0)', async () => {
    const fake = new FakeRedis();
    const svc = makeService(fake);
    const floor: DurableFloor = { fields: { level_up: '100', login: '50' } };

    await svc.seedBucket(KEY, floor);

    expect(fake.hgetSync(KEY, 'level_up')).toBe('100');
    expect(fake.hgetSync(KEY, 'login')).toBe('50');
  });

  it('writes the seeded marker LAST and isSeeded reports it', async () => {
    const fake = new FakeRedis();
    const svc = makeService(fake);

    expect(await svc.isSeeded(KEY)).toBe(false);
    await svc.seedBucket(KEY, { fields: { a: '1' } });
    expect(await svc.isSeeded(KEY)).toBe(true);
    expect(fake.hgetSync(KEY, SEEDED_MARKER_FIELD)).toBe('1');
  });

  it('HSETNX preserves a live increment — never clobbers HINCRBY (ST1)', async () => {
    const fake = new FakeRedis();
    const svc = makeService(fake);

    // A worker already rehydrated + incremented: durable floor 100, +1 applied.
    fake.hsetnxSync(KEY, 'level_up', '100');
    fake.hincrbySync(KEY, 'level_up', 1); // → 101

    // A SECOND rehydrator races in and re-seeds from the same floor.
    await svc.seedBucket(KEY, { fields: { level_up: '100' } });

    // HSETNX no-ops on the already-present field: the +1 is NOT lost.
    expect(fake.hgetSync(KEY, 'level_up')).toBe('101');
  });

  it('two concurrent rehydrators each +1 → floor+2, nothing lost', async () => {
    const fake = new FakeRedis();
    const svc = makeService(fake);
    const floor: DurableFloor = { fields: { c: '10' } };

    // Interleave: seed A, incr A, seed B (races), incr B.
    await svc.seedBucket(KEY, floor);
    fake.hincrbySync(KEY, 'c', 1);
    await svc.seedBucket(KEY, floor); // second seed no-ops on 'c'
    fake.hincrbySync(KEY, 'c', 1);

    expect(fake.hgetSync(KEY, 'c')).toBe('12'); // 10 floor + 2 increments
  });

  it('seeds membership sets via SADD (union-idempotent, double-seed harmless)', async () => {
    const fake = new FakeRedis();
    const svc = makeService(fake);
    const floor: DurableFloor = { members: ['u1', 'u2'] };

    await svc.seedBucket(KEY, floor);
    await svc.seedBucket(KEY, floor); // double-seed
    fake.saddSync(KEY, ['u3']); // live increment

    expect(new Set(fake.smembersSync(KEY))).toEqual(new Set(['u1', 'u2', 'u3']));
  });

  it('flush skips a bucket with NO seeded marker (half-seed guard, ST2)', async () => {
    const fake = new FakeRedis();
    const svc = makeService(fake);

    // Simulate a half-seeded bucket: a field present but the marker never written.
    fake.hsetnxSync(KEY, 'a', '5');
    expect(await svc.isSeeded(KEY)).toBe(false); // flusher would SKIP this
  });

  it('seedIfMissing seeds once, no-ops when already seeded', async () => {
    const fake = new FakeRedis();
    const svc = makeService(fake);

    expect(await svc.seedIfMissing(KEY, { fields: { a: '1' } })).toBe(true);
    expect(await svc.seedIfMissing(KEY, { fields: { a: '999' } })).toBe(false);
    // Second call must NOT re-seed a: HSETNX would no-op anyway, but the guard
    // short-circuits before any write.
    expect(fake.hgetSync(KEY, 'a')).toBe('1');
  });

  it('re-seeding an already-seeded bucket is a no-op', async () => {
    const fake = new FakeRedis();
    const svc = makeService(fake);

    await svc.seedBucket(KEY, { fields: { a: '1' } });
    fake.hincrbySync(KEY, 'a', 3); // → 4
    await svc.seedBucket(KEY, { fields: { a: '1' } }); // retry

    expect(fake.hgetSync(KEY, 'a')).toBe('4');
  });
});
