import type { Domain } from '../../common/redis-keys/redis-keys';
import type { DirtyRegistry } from './dirty-registry';
import type { DomainFlushPlan, FlushService, FlushSweepResult } from './flush.service';
import { CAT_FLUSH_PLAN, CNT_FLUSH_PLAN, EXC_FLUSH_PLAN } from './flush-plans';
import { FlushJobService, type ExtraDomainFlushPlan } from './flush-job.service';

/**
 * Stage-C additive per-domain sweep seam. Verifies that:
 *  - with NO extra plans, the sweep is byte-for-byte the 002 sweep (cnt/exc/cat,
 *    result carries NO `extra` key) — zero regression;
 *  - story-registered EXTRA_DOMAIN_FLUSH_PLANS are drained + flushed additively;
 *  - a domain shared by multiple plans is drained ONCE and each plan flushed over
 *    the same batch (mirrors 002's cnt/exc split).
 */

const RESULT: FlushSweepResult = { drained: 0, flushed: 0, skippedUnseeded: 0, upserts: 0 };

function fakeDirty(): { registry: DirtyRegistry; drained: Domain[] } {
  const drained: Domain[] = [];
  const registry = {
    async drain(domain: Domain): Promise<string[]> {
      drained.push(domain);
      return [`k:${domain}`];
    },
  } as unknown as DirtyRegistry;
  return { registry, drained };
}

function fakeFlush(): { flush: FlushService; plans: DomainFlushPlan[] } {
  const plans: DomainFlushPlan[] = [];
  const flush = {
    async sealFinalFlush(plan: DomainFlushPlan): Promise<FlushSweepResult> {
      plans.push(plan);
      return RESULT;
    },
  } as unknown as FlushService;
  return { flush, plans };
}

describe('FlushJobService.sweep — Stage-C extra-domain seam', () => {
  it('no extra plans → exactly the 002 sweep (cnt/exc/cat), no `extra` key (zero regression)', async () => {
    const { registry, drained } = fakeDirty();
    const { flush, plans } = fakeFlush();
    const svc = new FlushJobService(registry, flush);

    const out = await svc.sweep();

    // Only the two 002 domains are drained (cnt once, cat once).
    expect(drained).toEqual(['cnt', 'cat']);
    // The three 002 plans flushed, in order.
    expect(plans).toEqual([CNT_FLUSH_PLAN, EXC_FLUSH_PLAN, CAT_FLUSH_PLAN]);
    // Result shape is unchanged: no `extra`.
    expect(out).toEqual({ cnt: RESULT, exc: RESULT, cat: RESULT });
    expect('extra' in out).toBe(false);
  });

  it('registered extra plan → its domain is drained + flushed additively after the 002 domains', async () => {
    const { registry, drained } = fakeDirty();
    const { flush, plans } = fakeFlush();
    const ecoPlan: DomainFlushPlan = { domain: 'eco', spec: { table: 'economy_flow' } as never, project: () => [] };
    const extras: ExtraDomainFlushPlan[] = [{ domain: 'eco', plan: ecoPlan }];
    const svc = new FlushJobService(registry, flush, extras);

    const out = await svc.sweep();

    // 002 domains, THEN the story domain.
    expect(drained).toEqual(['cnt', 'cat', 'eco']);
    expect(plans).toContain(ecoPlan);
    expect(out.extra).toEqual({ 'eco:economy_flow': RESULT });
  });

  it('two plans on one domain → that domain is drained ONCE, both plans flushed over the same batch', async () => {
    const { registry, drained } = fakeDirty();
    const { flush } = fakeFlush();
    const monPlan: DomainFlushPlan = { domain: 'mon', spec: { table: 'monetization_day' } as never, project: () => [] };
    const payerPlan: DomainFlushPlan = { domain: 'mon', spec: { table: 'payer_day' } as never, project: () => [] };
    const svc = new FlushJobService(registry, flush, [
      { domain: 'mon', plan: monPlan },
      { domain: 'mon', plan: payerPlan },
    ]);

    const out = await svc.sweep();

    // `mon` appears exactly once in the drain log despite two plans.
    expect(drained.filter((d) => d === 'mon')).toEqual(['mon']);
    expect(out.extra).toEqual({ 'mon:monetization_day': RESULT, 'mon:payer_day': RESULT });
  });
});
