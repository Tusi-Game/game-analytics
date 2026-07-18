import { Redis } from 'ioredis';
import { WindowedDedupGate, UnimplementedPurchaseDedupGate, PurchaseDedupGate, DedupOutcome } from './dedup';
import { DEDUP_TTL_SECONDS } from '../redis-keys/ttl';

/**
 * Two dedup regimes, NEVER mixed (foundation §4.1, DARK-SPOT #8). The windowed
 * gate claims event_id via SET NX EX 24h; purchase money uses a DURABLE seam and
 * is NEVER routed through the window (a >24h retry through the window would
 * double-count money).
 */

/** Fake Redis modelling exactly `SET key val EX ttl NX` and a manual TTL sweep. */
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();
  private clock = 0;

  advanceSeconds(s: number): void {
    this.clock += s * 1000;
    for (const [k, v] of this.store) {
      if (v.expiresAt !== null && v.expiresAt <= this.clock) {
        this.store.delete(k);
      }
    }
  }

  async set(key: string, value: string, _exFlag: 'EX', ttlSeconds: number, _nxFlag: 'NX'): Promise<'OK' | null> {
    if (this.store.has(key)) {
      return null; // NX: key present → not set.
    }
    this.store.set(key, { value, expiresAt: this.clock + ttlSeconds * 1000 });
    return 'OK';
  }
}

function makeGate(fake: FakeRedis): WindowedDedupGate {
  return new WindowedDedupGate(fake as unknown as Redis);
}

describe('WindowedDedupGate (foundation §4.1 — windowed regime)', () => {
  it('first claim wins (claimed), immediate repeat within window loses (duplicate)', async () => {
    const fake = new FakeRedis();
    const gate = makeGate(fake);
    expect(await gate.claim('game-42', 'evt-1')).toBe('claimed');
    expect(await gate.claim('game-42', 'evt-1')).toBe('duplicate');
  });

  it('a repeat AFTER the 24h window claims again (window may double-count non-money)', async () => {
    const fake = new FakeRedis();
    const gate = makeGate(fake);
    expect(await gate.claim('game-42', 'evt-1')).toBe('claimed');
    fake.advanceSeconds(DEDUP_TTL_SECONDS + 1); // past 24h → marker expired
    expect(await gate.claim('game-42', 'evt-1')).toBe('claimed');
  });

  it('a repeat JUST WITHIN the window is still a duplicate', async () => {
    const fake = new FakeRedis();
    const gate = makeGate(fake);
    await gate.claim('game-42', 'evt-1');
    fake.advanceSeconds(DEDUP_TTL_SECONDS - 60); // still inside 24h
    expect(await gate.claim('game-42', 'evt-1')).toBe('duplicate');
  });

  it('different games do not collide (isolation)', async () => {
    const fake = new FakeRedis();
    const gate = makeGate(fake);
    expect(await gate.claim('game-A', 'evt-1')).toBe('claimed');
    expect(await gate.claim('game-B', 'evt-1')).toBe('claimed');
  });
});

describe('PurchaseDedupGate SEAM (foundation §4.1 — durable regime, 006-owned)', () => {
  it('the 002 placeholder is NOT implemented — invoking it hard-errors', async () => {
    const gate = new UnimplementedPurchaseDedupGate();
    await expect(gate.claimTransaction('game-42', 'txn-1')).rejects.toThrow(/006-monetization/);
  });

  it('a durable gate dedups a >24h-apart money retry to EXACTLY ONE (never windowed)', async () => {
    // Model the durable transaction_id UNIQUE gate 006 will implement: the key
    // has NO time window, so a retry days later still collapses to one.
    class DurableGate implements PurchaseDedupGate {
      private seen = new Set<string>();
      async claimTransaction(gameId: string, transactionId: string): Promise<DedupOutcome> {
        const key = `${gameId}:${transactionId}`;
        if (this.seen.has(key)) return 'duplicate';
        this.seen.add(key);
        return 'claimed';
      }
    }
    const gate = new DurableGate();
    expect(await gate.claimTransaction('game-42', 'txn-1')).toBe('claimed');
    // ... days later, a retry arrives. No TTL means it is STILL a duplicate.
    expect(await gate.claimTransaction('game-42', 'txn-1')).toBe('duplicate');
    // Net money counts = exactly one. The windowed gate could NOT provide this
    // guarantee past 24h — which is why money must never use it.
  });
});
