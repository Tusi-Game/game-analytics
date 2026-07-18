import { Redis } from 'ioredis';
import { DirtyRegistry } from './dirty-registry';

/**
 * Dirty-registry (foundation §3.2): mark buckets dirty, drain a stable snapshot,
 * lose nothing marked mid-sweep.
 */
class FakeRedis {
  private sets = new Map<string, Set<string>>();
  private set(k: string): Set<string> {
    let s = this.sets.get(k);
    if (!s) this.sets.set(k, (s = new Set()));
    return s;
  }
  async sadd(k: string, ...m: string[]): Promise<number> {
    const s = this.set(k);
    m.forEach((x) => s.add(x));
    return m.length;
  }
  async smembers(k: string): Promise<string[]> {
    return [...(this.sets.get(k) ?? new Set<string>())];
  }
  async scard(k: string): Promise<number> {
    return this.sets.get(k)?.size ?? 0;
  }
  async exists(k: string): Promise<number> {
    return this.sets.has(k) && (this.sets.get(k)?.size ?? 0) > 0 ? 1 : 0;
  }
  async rename(a: string, b: string): Promise<'OK'> {
    const s = this.sets.get(a);
    if (!s) throw new Error('ERR no such key');
    this.sets.set(b, s);
    this.sets.delete(a);
    return 'OK';
  }
  async del(k: string): Promise<number> {
    return this.sets.delete(k) ? 1 : 0;
  }
}

function make(): { reg: DirtyRegistry; fake: FakeRedis } {
  const fake = new FakeRedis();
  return { reg: new DirtyRegistry(fake as unknown as Redis), fake };
}

describe('DirtyRegistry (foundation §3.2)', () => {
  it('marks buckets dirty (idempotent) and reports size', async () => {
    const { reg } = make();
    await reg.mark('cnt', 'g:cnt:2026-07-18');
    await reg.mark('cnt', 'g:cnt:2026-07-18'); // dup
    await reg.mark('cnt', 'g:cnt:2026-07-19');
    expect(await reg.size('cnt')).toBe(2);
  });

  it('drain returns the snapshot and clears the live set', async () => {
    const { reg } = make();
    await reg.mark('cat', 'g:cat:login');
    await reg.mark('cat', 'g:cat:logout');
    const drained = await reg.drain('cat');
    expect(new Set(drained)).toEqual(new Set(['g:cat:login', 'g:cat:logout']));
    expect(await reg.size('cat')).toBe(0);
  });

  it('drain of an empty registry returns []', async () => {
    const { reg } = make();
    expect(await reg.drain('cnt')).toEqual([]);
  });

  it('marks made AFTER a drain land in the next sweep (nothing lost)', async () => {
    const { reg } = make();
    await reg.mark('cnt', 'a');
    await reg.drain('cnt'); // sweep 1
    await reg.mark('cnt', 'b'); // touched after sweep started
    expect(await reg.drain('cnt')).toEqual(['b']); // sweep 2 picks it up
  });

  it('domains are isolated', async () => {
    const { reg } = make();
    await reg.mark('cnt', 'x');
    await reg.mark('cat', 'y');
    expect(await reg.drain('cnt')).toEqual(['x']);
    expect(await reg.drain('cat')).toEqual(['y']);
  });
});
