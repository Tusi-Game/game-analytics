/**
 * Step-7 durable-immediate hook for `kind = session` (bridge 02.5 sequences A + B,
 * T-04.7..12). Registered with the kind dispatcher under KIND_DURABLE_REGISTRATION.
 *
 * Runs ONLY for routed, deduped, open-day `session` records (the kernel stops
 * earlier otherwise). Order within this hook is A ≺ B (spine row before offset
 * math — Foundation §8.4). Every write is durable-immediate to Postgres and
 * strictly precedes step 8 (durable ≺ hot — the crash-safe direction; a crash
 * between leaves the projection BEHIND the spine truth, never ahead).
 *
 *   7a  seed first_seen (insert-if-absent, reports created?)  — sequence A
 *   7b  offset = logical_day(corrected_start) − logical_day(first_seen)
 *       - negative offset (≥ −2, in-grace race) → skip bit + counter; tally
 *         `negative_offset` on the ARRIVAL day; never back-date first_seen; the
 *         session still counts/splits (that is the hot hook's job).
 *       - over-horizon (offset ≥ span) → silent no-op, no tally (untracked).
 *   7b′ set-once bit, report 0→1 transition                    — sequence B
 *
 * The hook computes the trusted session once and hands ALL of it (created flag,
 * transition flag, offset, cohort day, trusted interval, start/end days) to the
 * step-8 hot hook via the branded {@link DurableWrittenToken} it returns — the
 * kernel threads that exact token into step 8, so the hot hook never recomputes
 * skew/duration/offset and the two steps cannot disagree.
 */

import { Injectable } from '@nestjs/common';
import type { RoutedRecord } from '../common/contracts/queue-jobs';
import type { DurableImmediateHook, DurableWrittenToken, SealCheckedToken } from '../workers/kernel/pipeline-steps';
import { arrivalBucketDay } from '../common/kernel/logical-day';
import { ExceptionTallyWriter } from '../workers/kernel/exception-tally.writer';
import { SpineRepository } from './spine.repository';
import { SessionConfigService } from './session-config.service';
import { parseSessionTimestamp } from './session-validator';
import { deriveTrustedSession, type TrustedSession } from './session-time';

/**
 * The payload the durable hook attaches to the branded step-7 token, read back by
 * the step-8 hot hook (both are threaded the SAME token by the kernel). Carrying
 * it on the token means the hot hook never recomputes skew/offset/transition.
 */
export interface SessionDurableState {
  readonly session: TrustedSession;
  /** Bridge 02.5 8a gate: increment cohort size iff this event created the row. */
  readonly created: boolean;
  /** Bridge 02.5 8b gate: increment the retention cell iff a 0→1 bit transition. */
  readonly bitTransition: boolean;
  /** logical_day(first_seen) = the cohort day (offset-0 anchor). */
  readonly cohortDate: string;
  /** offset = logical_day(corrected_start) − cohort day; undefined when skipped. */
  readonly offset: number | undefined;
}

/** Marker field so the hot hook can recognise a session-authored token. */
const SESSION_STATE = '__session_durable_state';

/** The branded token carrying {@link SessionDurableState}. */
type SessionDurableToken = DurableWrittenToken & { readonly [SESSION_STATE]: SessionDurableState };

/** Attach the computed state to a branded token (contained cast; no `any`). */
function brandToken(state: SessionDurableState): SessionDurableToken {
  return { [SESSION_STATE]: state } as unknown as SessionDurableToken;
}

/** Read the session state off a step-7 token, or null if not session-authored. */
export function readSessionDurableState(token: DurableWrittenToken): SessionDurableState | null {
  const candidate = token as Partial<SessionDurableToken>;
  return candidate[SESSION_STATE] ?? null;
}

/** Number of days between two "YYYY-MM-DD" logical days (b − a), integer. */
function dayDiff(a: string, b: string): number {
  const MS_PER_DAY = 86_400_000;
  const aMs = Date.parse(`${a}T00:00:00Z`);
  const bMs = Date.parse(`${b}T00:00:00Z`);
  return Math.round((bMs - aMs) / MS_PER_DAY);
}

@Injectable()
export class SessionDurableHook implements DurableImmediateHook {
  constructor(
    private readonly spine: SpineRepository,
    private readonly tally: ExceptionTallyWriter,
    private readonly sessionConfig: SessionConfigService,
  ) {}

  async write(record: RoutedRecord, _sealChecked: SealCheckedToken): Promise<DurableWrittenToken> {
    const { envelope } = record;
    const gameId = envelope.game_id;
    const reportingOffsetMinutes = this.sessionConfig.reportingOffsetMinutes();

    // Recompute the trusted session (server-authoritative — client duration_ms
    // never trusted). Timestamps validated in step 3, so parse cannot fail here;
    // fall back defensively to 0 to keep types total (a null would have quarantined).
    const rawStart = parseSessionTimestamp(envelope.props['session_start_time']) ?? 0;
    const rawEnd = parseSessionTimestamp(envelope.props['session_end_time']) ?? 0;
    const knobs = await this.sessionConfig.timeKnobs(gameId);
    const session = deriveTrustedSession(
      rawStart,
      rawEnd,
      envelope.client_sent_time,
      envelope.server_received_time,
      knobs,
      reportingOffsetMinutes,
    );

    // Activeness = CLIENT engagement only (R11). A server-provenance session never
    // seeds the spine or sets a bit; it still folds into the day aggregates.
    // (The session-kind gate is the primary enforcement; this is the residual
    // provenance guard the brief calls for should 010 ever emit kind=session.)
    if (record.provenance !== 'client') {
      return brandToken({
        session,
        created: false,
        bitTransition: false,
        cohortDate: session.startDay,
        offset: undefined,
      });
    }

    const userId = envelope.user_id;
    // No user_id → cannot anchor a spine row; the session still counts (hot hook).
    // A non-`session` event with no spine row would tally `no_spine_row` at the
    // front door, but a `session` event with no user_id simply seeds nothing.
    if (typeof userId !== 'string' || userId.length === 0) {
      return brandToken({
        session,
        created: false,
        bitTransition: false,
        cohortDate: session.startDay,
        offset: undefined,
      });
    }

    const span = await this.sessionConfig.bitmapSpan(gameId);

    // ---- 7a — sequence A: insert-if-absent first_seen = corrected start -------
    const firstSeenDate = new Date(session.correctedStart);
    const seed = await this.spine.seedFirstSeen(gameId, userId, firstSeenDate, span);

    // ---- 7b — offset math (against the AUTHORITATIVE first_seen) --------------
    const cohortDate = this.sessionConfig.logicalDayOf(seed.firstSeen.getTime());
    const offset = dayDiff(cohortDate, session.startDay);

    // Negative offset (in-grace processing race, bounded ≥ −2): skip bit + counter,
    // tally negative_offset on the ARRIVAL day, never back-date first_seen. The
    // session still counts (hot hook uses `session`, unaffected by this skip).
    if (offset < 0) {
      await this.tally.tally(
        gameId,
        arrivalBucketDay(envelope.server_received_time, reportingOffsetMinutes),
        'negative_offset',
      );
      return brandToken({ session, created: seed.created, bitTransition: false, cohortDate, offset: undefined });
    }

    // Over-horizon (offset ≥ span): silent no-op BY DESIGN — untracked, no tally.
    if (offset >= span) {
      return brandToken({ session, created: seed.created, bitTransition: false, cohortDate, offset: undefined });
    }

    // ---- 7b′ — sequence B: set-once bit, report the 0→1 transition -----------
    const bitTransition = await this.spine.setActivityBit(gameId, userId, offset);

    return brandToken({ session, created: seed.created, bitTransition, cohortDate, offset });
  }
}
