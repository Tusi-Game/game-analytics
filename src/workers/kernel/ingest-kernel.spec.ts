import type { EventEnvelope, EventKind } from '../../common/contracts/envelope';
import { WindowedDedupGate, PurchaseDedupGate, DedupOutcome } from '../../common/kernel/dedup';
import {
  IngestKernel,
  KernelContext,
  NameCapGate,
  PiiScrubPort,
  TypedValidator,
  OTHER_OVERFLOW_NAME,
} from './ingest-kernel';
import {
  AckPort,
  DurableImmediateHook,
  DurableWrittenToken,
  HotUpdatedToken,
  HotUpdateHook,
  RawAppendedToken,
  RawAppendIntent,
  RawAppendPort,
} from './pipeline-steps';
import { PiiScrubService } from '../../security/pii-scrub.service';
import { KernelPiiScrubAdapter } from '../../security/kernel-pii-scrub.adapter';
import type { GameConfigService } from '../../config/game-config.service';

/**
 * The 9-step op-order kernel (foundation §3.1). Verifies the normative ORDER
 * (raw-append ≺ seal ≺ dedup ≺ durable ≺ hot ≺ ack — DARK-SPOT #3), the routing
 * decisions, and that quarantine/drop feed NOTHING.
 */

/** Records every step call in order so we can assert the invariant chain. */
class OrderRecorder {
  readonly log: string[] = [];
}

class SpyRawAppend implements RawAppendPort {
  constructor(private readonly rec: OrderRecorder) {}
  async append(
    _e: EventEnvelope,
    _d: string,
    intent: RawAppendIntent,
    _j: string,
  ): Promise<{ token: RawAppendedToken; appended: boolean }> {
    this.rec.log.push(`raw-append:${intent}`);
    return { token: {} as RawAppendedToken, appended: intent !== 'skip-drop' };
  }
}

class SpyDurable implements DurableImmediateHook {
  constructor(private readonly rec: OrderRecorder) {}
  async write(): Promise<DurableWrittenToken> {
    this.rec.log.push('durable');
    return {} as DurableWrittenToken;
  }
}

class SpyHot implements HotUpdateHook {
  readonly bucketNames: string[] = [];
  constructor(private readonly rec: OrderRecorder) {}
  async update(_r: unknown, bucketName: string): Promise<HotUpdatedToken> {
    this.rec.log.push('hot');
    this.bucketNames.push(bucketName);
    return {} as HotUpdatedToken;
  }
}

class SpyAck implements AckPort {
  constructor(private readonly rec: OrderRecorder) {}
  async ack(): Promise<void> {
    this.rec.log.push('ack');
  }
}

class FakeWindowed {
  claims: string[] = [];
  outcome: DedupOutcome = 'claimed';
  async claim(_g: string, eventId: string): Promise<DedupOutcome> {
    this.claims.push(eventId);
    return this.outcome;
  }
}

class FakePurchase implements PurchaseDedupGate {
  txns: string[] = [];
  outcome: DedupOutcome = 'claimed';
  async claimTransaction(_g: string, txn: string): Promise<DedupOutcome> {
    this.txns.push(txn);
    return this.outcome;
  }
}

class CapGate implements NameCapGate {
  constructor(
    private readonly cap: number,
    private readonly known = new Set<string>(),
  ) {}
  async resolveName(_g: string, name: string): Promise<string> {
    if (this.known.has(name)) return name;
    if (this.known.size >= this.cap) return OTHER_OVERFLOW_NAME;
    this.known.add(name);
    return name;
  }
}

class Validator implements TypedValidator {
  invalidKinds = new Set<EventKind>();
  validate(kind: EventKind): 'quarantined_typed' | null {
    return this.invalidKinds.has(kind) ? 'quarantined_typed' : null;
  }
}

function env(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  const t = Date.parse('2026-07-18T12:00:00Z');
  return {
    game_id: 'game-42',
    event_id: 'evt-1',
    name: 'login',
    kind: 'generic',
    client_event_time: t,
    client_sent_time: t,
    server_received_time: t,
    props: {},
    ...overrides,
  };
}

function ctx(overrides: Partial<KernelContext> = {}): KernelContext {
  return {
    reportingOffsetMinutes: 0,
    now: Date.parse('2026-07-18T12:00:01Z'),
    provenance: 'client',
    batchJobId: 'job-1',
    ...overrides,
  };
}

interface Harness {
  kernel: IngestKernel;
  rec: OrderRecorder;
  windowed: FakeWindowed;
  purchase: FakePurchase;
  cap: CapGate;
  validator: Validator;
  hot: SpyHot;
}

/** No-op PII scrub for the ordering/routing tests (scrub is tested separately). */
class PassThroughScrub implements PiiScrubPort {
  async scrubProps(_gameId: string, props: Record<string, unknown>): Promise<Record<string, unknown>> {
    return props;
  }
}

function build(opts: { cap?: number; known?: Set<string> } = {}): Harness {
  const rec = new OrderRecorder();
  const windowed = new FakeWindowed();
  const purchase = new FakePurchase();
  const cap = new CapGate(opts.cap ?? 1000, opts.known);
  const validator = new Validator();
  const hot = new SpyHot(rec);
  const kernel = new IngestKernel(
    new SpyRawAppend(rec),
    windowed as unknown as WindowedDedupGate,
    purchase,
    cap,
    validator,
    new SpyDurable(rec),
    hot,
    new SpyAck(rec),
    new PassThroughScrub(),
  );
  return { kernel, rec, windowed, purchase, cap, validator, hot };
}

describe('IngestKernel op-ordering (foundation §3.1)', () => {
  it('a routed generic event runs steps in the normative order: append ≺ dedup ≺ durable ≺ hot ≺ ack', async () => {
    const h = build();
    const out = await h.kernel.process(env(), ctx());
    expect(out.counted).toBe(true);
    expect(out.verdicts.disposition).toBe('route');
    // raw-append is FIRST; hot (counter) is AFTER dedup+durable; ack is LAST.
    expect(h.rec.log).toEqual(['raw-append:append', 'durable', 'hot', 'ack']);
    const appendIdx = h.rec.log.indexOf('raw-append:append');
    const hotIdx = h.rec.log.indexOf('hot');
    expect(appendIdx).toBeLessThan(hotIdx); // counter-before-append is impossible
    // Within cap → counts under its own name (not `other`).
    expect(h.hot.bucketNames).toEqual(['login']);
  });

  it('nameless event → DROP, never raw-appended, never counted', async () => {
    const h = build();
    const out = await h.kernel.process(env({ name: '  ' }), ctx());
    expect(out.verdicts.disposition).toBe('drop');
    expect(out.verdicts.reason).toBe('nameless');
    expect(out.counted).toBe(false);
    expect(h.rec.log).toEqual([]); // step 4 never reached
  });

  it('duplicate (windowed) → routes but is NOT counted (dedup_passed=false)', async () => {
    const h = build();
    h.windowed.outcome = 'duplicate';
    const out = await h.kernel.process(env(), ctx());
    expect(out.counted).toBe(false);
    expect(out.verdicts.dedup_passed).toBe(false);
    // Raw-append DID run (duplicates are appended); hot did NOT.
    expect(h.rec.log).toContain('raw-append:append');
    expect(h.rec.log).not.toContain('hot');
  });

  describe('reserved-name override (§H-2) + unknown_kind + typed-invalid quarantine', () => {
    it('name=purchase with declared kind=generic routes to the PURCHASE typed path (resolved_kind)', async () => {
      const h = build();
      // Provide a transaction_id so the durable gate claims.
      const out = await h.kernel.process(
        env({ name: 'purchase', kind: 'generic', props: { transaction_id: 'txn-9' } }),
        ctx(),
      );
      expect(out.record?.resolved_kind).toBe('purchase');
      // It used the DURABLE purchase gate, NOT the windowed one (DARK-SPOT #8).
      expect(h.purchase.txns).toEqual(['txn-9']);
      expect(h.windowed.claims).toEqual([]);
    });

    it('unrecognized kind → quarantine unknown_kind (raw-appended, feeds nothing, never coerced to generic)', async () => {
      const h = build();
      const out = await h.kernel.process(env({ kind: 'telemetry_v2' as EventKind }), ctx());
      expect(out.verdicts.disposition).toBe('quarantine');
      expect(out.verdicts.reason).toBe('unknown_kind');
      expect(out.counted).toBe(false);
      // Raw-appended with the quarantine marker, then STOP (no hot).
      expect(h.rec.log).toEqual(['raw-append:append-quarantine']);
    });

    it('typed-invalid economy → quarantined_typed, raw-appended, feeds nothing', async () => {
      const h = build();
      h.validator.invalidKinds.add('economy');
      const out = await h.kernel.process(env({ name: 'coins_spent', kind: 'economy' }), ctx());
      expect(out.verdicts.reason).toBe('quarantined_typed');
      expect(h.rec.log).toEqual(['raw-append:append-quarantine']);
      expect(out.counted).toBe(false);
    });
  });

  it('sealed corrected-day → quarantine sealed_late (raw-appended), sealed day untouched', async () => {
    const h = build();
    // now is far past the corrected day's seal (D_end + 48h).
    const out = await h.kernel.process(env(), ctx({ now: Date.parse('2026-07-25T00:00:00Z') }));
    expect(out.verdicts.disposition).toBe('quarantine');
    expect(out.verdicts.reason).toBe('sealed_late');
    expect(out.verdicts.seal_state).toBe('sealed');
    expect(out.counted).toBe(false);
    // Raw-append happened BEFORE the seal check; hot did not.
    expect(h.rec.log).toEqual(['raw-append:append']);
  });

  describe('R3 name-cap → other-overflow (kept + counted, NOT dropped)', () => {
    it('over-cap distinct name routes under `other` and IS counted', async () => {
      const known = new Set<string>(['a', 'b', 'c']); // cap already full
      const h = build({ cap: 3, known });
      const out = await h.kernel.process(env({ name: 'd', event_id: 'evt-d' }), ctx());
      // NOT dropped — routed and counted, under the `other` bucket.
      expect(out.verdicts.disposition).toBe('route');
      expect(out.counted).toBe(true);
      expect(out.verdicts.reason).toBeUndefined();
      // The hot hook counted it under the literal `other` overflow bucket (R3),
      // not under 'd' and NOT dropped — the whole point of the reconciliation.
      expect(h.hot.bucketNames).toEqual([OTHER_OVERFLOW_NAME]);
      // The record still carries the original wire name verbatim (frozen contract).
      expect(out.record?.envelope.name).toBe('d');
    });
  });

  it('time_fallback event still routes + counts (buckets on server_received day)', async () => {
    const h = build();
    const t = Date.parse('2026-07-18T12:00:00Z');
    // event_time 40h in the past with a fresh send → sanity clamp → fallback.
    const out = await h.kernel.process(
      env({ client_event_time: t - 40 * 3600_000, client_sent_time: t, server_received_time: t }),
      ctx({ now: t + 1000 }),
    );
    expect(out.counted).toBe(true);
    // corrected_day is the server-received day, not the (untrusted) 2 days back.
    expect(out.record?.corrected_day).toBe('2026-07-18');
  });

  it('effective version defaults to 1 when absent on the wire', async () => {
    const h = build();
    const out = await h.kernel.process(env(), ctx());
    expect(out.record?.v).toBe(1);
  });
});

/**
 * PII scrub happens in step 3 BEFORE the step-4 raw append (ops-envelope §9).
 * Uses the REAL PiiScrubService via the kernel adapter + a capturing raw-append,
 * so a denylisted key / PII-shaped value never reaches the raw file or the
 * routed record's props.
 */
describe('IngestKernel PII scrub (pre-raw-append)', () => {
  it('scrubs denylisted keys + PII values before the raw append AND in the routed record', async () => {
    const captured: EventEnvelope[] = [];
    const capturingAppend: RawAppendPort = {
      async append(e, _d, intent): Promise<{ token: RawAppendedToken; appended: boolean }> {
        captured.push(e);
        return { token: {} as RawAppendedToken, appended: intent !== 'skip-drop' };
      },
    };
    const scrubber = new PiiScrubService();
    const adapter = new KernelPiiScrubAdapter(scrubber, {
      getConfig: async () => ({}),
    } as unknown as GameConfigService);
    const kernel = new IngestKernel(
      capturingAppend,
      new FakeWindowed() as unknown as WindowedDedupGate,
      new FakePurchase(),
      new CapGate(1000),
      new Validator(),
      new SpyDurable(new OrderRecorder()),
      new SpyHot(new OrderRecorder()),
      new SpyAck(new OrderRecorder()),
      adapter,
    );

    const out = await kernel.process(
      env({ props: { email: 'a@b.com', note: 'reach me at x@y.com', level: 5 } }),
      ctx(),
    );

    // The raw-appended envelope has NO denylisted key and NO PII-shaped value.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.props).toEqual({ note: '[redacted:email]', level: 5 });
    // The routed record (fed to consumers / catalog) is scrubbed identically.
    expect(out.record?.envelope.props).toEqual({ note: '[redacted:email]', level: 5 });
  });
});
