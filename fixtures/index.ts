/**
 * Typed loader for the shared golden envelope-stream fixture (R4).
 *
 * ONE physical fixture set, three consumers (002 ingest tests, 008 client SDK,
 * 009 server SDK). This loader is the only sanctioned reader: it strips the
 * documentation-only `_fixture` annotation from every envelope so consumers get
 * clean {@link EventEnvelope}s, and exposes the per-event expected verdicts for
 * conformance assertions.
 *
 * Kept dependency-free (plain `fs` + `JSON.parse`) so SDK packages can import it
 * without pulling in NestJS.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventEnvelope } from '../src/common/contracts/envelope';
import type { BatchRequest } from '../src/common/contracts/batch';
import type { Disposition } from '../src/common/contracts/queue-jobs';
import type { ExceptionReason } from '../src/common/contracts/exception-reason';

/** Directory holding the golden fixtures (this file's own dir). */
export const FIXTURES_DIR = __dirname;

/** The documentation-only annotation carried inline on each fixture envelope. */
export interface FixtureAnnotation {
  /** Short case label. */
  case: string;
  /** Expected front-door disposition, plus the special `route-duplicate` marker. */
  verdict: Disposition | 'route-duplicate';
  /** Expected tally reason for a non-route verdict. */
  reason?: ExceptionReason;
  /** Expected resolved kind after any §H-2 override. */
  resolved_kind?: string;
  /** Expected hot-bucket name (may be `other` for over-cap). */
  bucket_name?: string;
  /** Free-text note. */
  note?: string;
}

/** One envelope plus its expected outcome, extracted from the fixture stream. */
export interface GoldenExpectation {
  envelope: EventEnvelope;
  expect: FixtureAnnotation;
}

/** The raw on-disk shape: a BatchRequest whose events carry `_fixture`. */
type AnnotatedEnvelope = EventEnvelope & { _fixture?: FixtureAnnotation };
type AnnotatedBatch = Omit<BatchRequest, 'events'> & { events: AnnotatedEnvelope[] };

function readRaw(): AnnotatedBatch {
  const path = join(FIXTURES_DIR, 'golden-envelope-stream.json');
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as AnnotatedBatch).events)) {
    throw new Error('[fixtures] golden-envelope-stream.json is not a valid batch object');
  }
  return parsed as AnnotatedBatch;
}

/** Strip the `_fixture` annotation from an envelope, returning a clean copy. */
function strip(envelope: AnnotatedEnvelope): EventEnvelope {
  const clone: AnnotatedEnvelope = { ...envelope };
  delete clone._fixture;
  return clone;
}

/**
 * Load the golden stream as a clean {@link BatchRequest} (annotations removed).
 * This is what a real SDK would send / the ingest door would receive.
 */
export function loadGoldenStream(): BatchRequest {
  const raw = readRaw();
  return {
    v: raw.v,
    sdk: raw.sdk,
    events: raw.events.map(strip),
  };
}

/**
 * Load the golden stream with each event's expected verdict retained, for
 * conformance assertions. Envelopes returned here are ALSO stripped of the
 * annotation (the annotation is surfaced in `expect`, never leaked into the
 * envelope that would be enqueued).
 */
export function goldenExpectations(): GoldenExpectation[] {
  const raw = readRaw();
  return raw.events.map((event) => {
    if (!event._fixture) {
      throw new Error(`[fixtures] envelope ${event.event_id} is missing its _fixture annotation`);
    }
    return { envelope: strip(event), expect: event._fixture };
  });
}
