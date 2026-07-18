import type { EventEnvelope } from '../../common/contracts/envelope';
import type { RoutedRecord } from '../../common/contracts/queue-jobs';
import type {
  DedupPassedToken,
  DurableWrittenToken,
  HotUpdateHook,
  RawAppendedToken,
  SealCheckedToken,
} from './pipeline-steps';

/**
 * DARK-SPOT #3 — the ordering chain is ENFORCED by the type system: calling the
 * hot-counter step (8) requires a `DedupPassedToken` (from step 6) and a
 * `DurableWrittenToken` (from step 7); step 6's token cannot be produced without
 * first holding step 4's `RawAppendedToken`. So "count before append" does not
 * type-check. These are COMPILE-TIME assertions — the test body is trivial; the
 * `@ts-expect-error` lines are the real assertion (they fail the build if the
 * mis-order ever becomes assignable). This spec compiling at all IS the proof.
 */
describe('op-order chain is enforced by the type system (DARK-SPOT #3)', () => {
  const record = {} as RoutedRecord;
  const envelope = {} as EventEnvelope;
  void envelope;

  // A fresh, unbranded object cannot masquerade as any ordering token.
  const notAToken = {};

  it('step 8 (hot) REQUIRES the dedup + durable tokens — a bare object is rejected', () => {
    const hot: HotUpdateHook = {
      async update() {
        return {} as ReturnType<HotUpdateHook['update']> extends Promise<infer T> ? T : never;
      },
    };

    // Valid call needs BOTH branded tokens (plus the resolved bucket name).
    const dedup = {} as DedupPassedToken;
    const durable = {} as DurableWrittenToken;
    void hot.update(record, 'login', dedup, durable);

    // @ts-expect-error — a plain object is NOT a DedupPassedToken (cannot skip step 6).
    void hot.update(record, 'login', notAToken, durable);

    // @ts-expect-error — a RawAppendedToken is NOT a DedupPassedToken: holding the
    // step-4 token alone does not let you call the counter (dedup must run first).
    void hot.update(record, 'login', {} as RawAppendedToken, durable);

    // @ts-expect-error — a SealCheckedToken is NOT a DurableWrittenToken either.
    void hot.update(record, 'login', dedup, {} as SealCheckedToken);

    expect(true).toBe(true);
  });
});
