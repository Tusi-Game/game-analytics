import { Redis } from 'ioredis';
import { connectRedisOrNull } from '../../testing/live-infra';
import { DirtyRegistry } from './dirty-registry';

/**
 * DirtyRegistry drain against LIVE Redis — regression for the TOCTOU RENAME race
 * (BUG FOUND in Unit 5). The old `EXISTS live` → `RENAME live snap` drain threw
 * `ReplyError: ERR no such key` when two drains of the same domain interleaved
 * (RENAME on a key a concurrent drain had already renamed away). This surfaced as
 * flaky failures across the integration suites, which share ONE Redis and contend
 * on the global `ops:dirty:{domain}` keys. The fix moves the whole snapshot-and-
 * clear into one atomic Lua body; this test drives real concurrency to prove it.
 *
 * Skips when Redis is unreachable.
 */
describe('DirtyRegistry drain concurrency (live Redis) — TOCTOU RENAME fix', () => {
  let redis: Redis | null;

  beforeAll(async () => {
    redis = await connectRedisOrNull();
  });
  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  it('N concurrent drains of the same domain never throw and deliver every member exactly once', async () => {
    if (!redis) return;
    const reg = new DirtyRegistry(redis);
    // Mark under the real 'cnt' domain but with a UNIQUE member prefix, and assert
    // only on our own tagged members — so this test is robust to other suites
    // marking/draining the SAME global `ops:dirty:cnt` key concurrently (the
    // registry is platform-scoped, not per-game). We deliberately do NOT `del` the
    // shared key: that would wipe a concurrent suite's pending marks.
    const tag = `regtest-${Math.random().toString(36).slice(2)}`;

    const members = Array.from({ length: 200 }, (_, i) => `${tag}:bucket:${i}`);
    for (const m of members) {
      await reg.mark('cnt', m);
    }

    // Fire many drains at once — the old code would throw ERR no such key here.
    const drains = await Promise.all(Array.from({ length: 12 }, () => reg.drain('cnt')));

    const delivered = drains.flat().filter((m) => m.startsWith(tag));
    // Every marked member delivered EXACTLY once across all concurrent drains
    // (the OLD code would have thrown ERR no such key before reaching here).
    expect(new Set(delivered)).toEqual(new Set(members));
    expect(delivered.length).toBe(members.length); // no duplicate delivery
    // None of OUR tagged members linger after the concurrent drains (foreign
    // members from other suites are ignored — the registry is shared).
    const remaining = (await redis.smembers('ops:dirty:cnt')).filter((m) => m.startsWith(tag));
    expect(remaining).toEqual([]);
  }, 30_000);

  it('a drain never throws ERR no such key even when the live set is absent', async () => {
    if (!redis) return;
    const reg = new DirtyRegistry(redis);
    // A freshly-drained domain: the atomic Lua returns an array rather than letting
    // RENAME throw on a missing key. (Foreign marks under the shared domain, if
    // any, only make the result non-empty — the guarantee under test is "never an
    // error", which the resolving promise proves.)
    const out = await reg.drain('cat');
    expect(Array.isArray(out)).toBe(true);
  });
});
