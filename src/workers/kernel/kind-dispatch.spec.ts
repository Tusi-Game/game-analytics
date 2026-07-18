import type { EventEnvelope, EventKind } from '../../common/contracts/envelope';
import type { RoutedRecord } from '../../common/contracts/queue-jobs';
import type { TypedValidator } from './ingest-kernel';
import type {
  DedupPassedToken,
  DurableImmediateHook,
  DurableWrittenToken,
  HotUpdatedToken,
  HotUpdateHook,
  SealCheckedToken,
} from './pipeline-steps';
import { NoopDurableImmediateHook, PermissiveTypedValidator } from './default-hooks';
import type { GenericHotUpdateHook } from './default-hooks';
import {
  KindDispatchDurableHook,
  KindDispatchHotHook,
  KindDispatchValidator,
  type KindDurableRegistration,
  type KindHotRegistration,
  type KindValidatorRegistration,
} from './kind-dispatch';

/**
 * Stage-C kind-dispatch seam (shared substrate for 003/004/006). Verifies:
 *  - delegation to a registered per-kind impl by resolved_kind;
 *  - fallback to the 002 default (permissive/noop/generic) for unregistered kinds
 *    (ZERO regression for generic + not-yet-wired typed kinds);
 *  - the hot-hook COMPOSITION contract (generic base ALWAYS runs, THEN the story
 *    accumulator — addition, not replacement);
 *  - the branded ordering token is preserved (durable token threaded verbatim).
 */

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

function record(kind: EventKind, overrides: Partial<EventEnvelope> = {}): RoutedRecord {
  return {
    envelope: env({ kind, ...overrides }),
    resolved_kind: kind,
    v: 1,
    corrected_time: Date.parse('2026-07-18T12:00:00Z'),
    corrected_day: '2026-07-18',
    provenance: 'client',
    verdicts: { dedup_passed: true, seal_state: 'open', disposition: 'route' },
  };
}

// Distinct branded token sentinels (cast once; the brand is compile-only).
const DEDUP = {} as DedupPassedToken;
const SEAL = {} as SealCheckedToken;

describe('KindDispatchValidator (step 3)', () => {
  function build(regs: KindValidatorRegistration[]): KindDispatchValidator {
    const d = new KindDispatchValidator(new PermissiveTypedValidator(), regs);
    d.onModuleInit();
    return d;
  }

  it('delegates to the registered validator for its kind', () => {
    const calls: EventKind[] = [];
    const economyValidator: TypedValidator = {
      validate(kind) {
        calls.push(kind);
        return 'quarantined_typed';
      },
    };
    const d = build([{ kind: 'economy', validator: economyValidator }]);

    expect(d.validate('economy', env({ kind: 'economy' }))).toBe('quarantined_typed');
    expect(calls).toEqual(['economy']);
  });

  it('falls back to PermissiveTypedValidator (accepts) for an unregistered kind — no regression', () => {
    const d = build([{ kind: 'economy', validator: { validate: () => 'quarantined_typed' } }]);
    // purchase + session have no registered story → permissive default accepts.
    expect(d.validate('purchase', env({ kind: 'purchase' }))).toBeNull();
    expect(d.validate('session', env({ kind: 'session' }))).toBeNull();
    // generic likewise (kernel never calls it for generic, but the fallback holds).
    expect(d.validate('generic', env())).toBeNull();
  });

  it('rejects a double-registration of the same kind (collision guard)', () => {
    const d = new KindDispatchValidator(new PermissiveTypedValidator(), [
      { kind: 'economy', validator: { validate: () => null } },
      { kind: 'economy', validator: { validate: () => 'quarantined_typed' } },
    ]);
    expect(() => d.onModuleInit()).toThrow(/duplicate validator registration for kind="economy"/);
  });
});

describe('KindDispatchDurableHook (step 7)', () => {
  function build(regs: KindDurableRegistration[]): KindDispatchDurableHook {
    const d = new KindDispatchDurableHook(new NoopDurableImmediateHook(), regs);
    d.onModuleInit();
    return d;
  }

  it('delegates to the registered durable hook by record.resolved_kind', async () => {
    const seen: string[] = [];
    const sessionDurable: DurableImmediateHook = {
      async write(rec) {
        seen.push(rec.resolved_kind);
        return {} as DurableWrittenToken;
      },
    };
    const d = build([{ kind: 'session', hook: sessionDurable }]);

    await d.write(record('session'), SEAL);
    expect(seen).toEqual(['session']);
  });

  it('falls back to the Noop durable hook for an unregistered kind (generic has no durable work)', async () => {
    const seen: string[] = [];
    const d = build([
      {
        kind: 'session',
        hook: {
          async write() {
            seen.push('session');
            return {} as DurableWrittenToken;
          },
        },
      },
    ]);

    // generic + purchase are unregistered → noop path, story hook never called.
    const t1 = await d.write(record('generic'), SEAL);
    const t2 = await d.write(record('purchase'), SEAL);
    expect(seen).toEqual([]);
    // Noop still mints a usable ordering token (pipeline stays uniform).
    expect(t1).toBeDefined();
    expect(t2).toBeDefined();
  });

  it('returns the delegate durable token VERBATIM (ordering brand preserved for step 8)', async () => {
    const storyToken = { __story: true } as unknown as DurableWrittenToken;
    const d = build([
      {
        kind: 'economy',
        hook: {
          async write() {
            return storyToken;
          },
        },
      },
    ]);

    const returned = await d.write(record('economy'), SEAL);
    // Same object identity — the dispatcher must not fabricate a new token.
    expect(returned).toBe(storyToken);
  });
});

describe('KindDispatchHotHook (step 8) — composition contract', () => {
  /** A spy generic base that records its call + returns a distinct hot token. */
  class SpyBase {
    readonly calls: Array<{ kind: EventKind; bucket: string }> = [];
    readonly token = { __base: true } as unknown as HotUpdatedToken;
    async update(rec: RoutedRecord, bucketName: string): Promise<HotUpdatedToken> {
      this.calls.push({ kind: rec.resolved_kind, bucket: bucketName });
      return this.token;
    }
  }

  function build(base: SpyBase, regs: KindHotRegistration[]): KindDispatchHotHook {
    const d = new KindDispatchHotHook(base as unknown as GenericHotUpdateHook, regs);
    d.onModuleInit();
    return d;
  }

  it('UNREGISTERED kind → runs ONLY the generic base (exactly 002 behavior, zero regression)', async () => {
    const base = new SpyBase();
    const storyCalls: string[] = [];
    const d = build(base, [
      {
        kind: 'economy',
        hook: {
          async update() {
            storyCalls.push('economy');
            return {} as HotUpdatedToken;
          },
        },
      },
    ]);

    const token = await d.update(record('generic'), 'login', DEDUP, {} as DurableWrittenToken);
    expect(base.calls).toEqual([{ kind: 'generic', bucket: 'login' }]);
    expect(storyCalls).toEqual([]); // no story for generic
    expect(token).toBe(base.token); // base token is the step-8 output
  });

  it('REGISTERED kind → generic base runs FIRST, THEN the story accumulator (addition, not replacement)', async () => {
    const base = new SpyBase();
    const order: string[] = [];
    base.update = async (rec, bucket) => {
      order.push('base');
      base.calls.push({ kind: rec.resolved_kind, bucket });
      return base.token;
    };
    const economyHook: HotUpdateHook = {
      async update() {
        order.push('story');
        return {} as HotUpdatedToken;
      },
    };
    const d = build(base, [{ kind: 'economy', hook: economyHook }]);

    const token = await d.update(
      record('economy', { name: 'coins_spent' }),
      'coins_spent',
      DEDUP,
      {} as DurableWrittenToken,
    );
    // Base FIRST, story SECOND — the documented composition order.
    expect(order).toEqual(['base', 'story']);
    // Generic base still counted cat/cnt/rank for the economy event.
    expect(base.calls).toEqual([{ kind: 'economy', bucket: 'coins_spent' }]);
    // The base token is the single step-8 ordering token (story token discarded).
    expect(token).toBe(base.token);
  });

  it('passes the SAME dedup + durable ordering tokens to the story hook (durable ≺ hot holds for the story too)', async () => {
    const base = new SpyBase();
    const durableToken = { __durable: true } as unknown as DurableWrittenToken;
    let received: { dedup: DedupPassedToken; durable: DurableWrittenToken } | null = null;
    const d = build(base, [
      {
        kind: 'session',
        hook: {
          async update(_r, _b, dedup, durable) {
            received = { dedup, durable };
            return {} as HotUpdatedToken;
          },
        },
      },
    ]);

    await d.update(record('session'), 'session', DEDUP, durableToken);
    expect(received).not.toBeNull();
    expect(received!.dedup).toBe(DEDUP);
    // The REAL durable token is threaded to the story — NOT the base's hot token.
    expect(received!.durable).toBe(durableToken);
  });

  it('rejects a double-registration of the same kind (collision guard)', () => {
    const base = new SpyBase();
    const d = new KindDispatchHotHook(base as unknown as GenericHotUpdateHook, [
      {
        kind: 'session',
        hook: {
          async update() {
            return {} as HotUpdatedToken;
          },
        },
      },
      {
        kind: 'session',
        hook: {
          async update() {
            return {} as HotUpdatedToken;
          },
        },
      },
    ]);
    expect(() => d.onModuleInit()).toThrow(/duplicate hot registration for kind="session"/);
  });

  it('no registrations at all → every kind runs base only (the current shipped state)', async () => {
    const base = new SpyBase();
    const d = build(base, []);
    await d.update(record('generic'), 'login', DEDUP, {} as DurableWrittenToken);
    await d.update(record('economy'), 'coins_spent', DEDUP, {} as DurableWrittenToken);
    expect(base.calls.map((c) => c.kind)).toEqual(['generic', 'economy']);
  });
});
