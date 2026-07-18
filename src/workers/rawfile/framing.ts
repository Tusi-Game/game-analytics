/**
 * Per-append framing + codec for the write-ahead raw day-file (bridge 01.5 §4).
 *
 * 002 owns the PER-APPEND FRAMING ONLY. Each batch append is a self-contained,
 * length-prefixed gzip member so that:
 *   - a crash mid-append leaves a DETECTABLE truncated trailing member (the
 *     length prefix promises N bytes that never arrived), which rebuild tooling
 *     SKIPS with a loud warning — never silently drops (§4, T-01.40 step 1);
 *   - the stream is MULTI-MEMBER-SAFE: every member is independently gunzip-able,
 *     so a decoder that iterates frames sees every batch (some naive decoders
 *     silently discard members after the first — forbidden, §4).
 *
 * Frame layout (all integers big-endian):
 *
 *     ┌────────┬──────────┬─────────────────────┐
 *     │ MAGIC  │ len (u32)│ gzip member (len B)  │
 *     │ 4 B    │ 4 B      │ …                    │
 *     └────────┴──────────┴─────────────────────┘
 *
 * The gzip member's payload is the UTF-8 JSON of one {@link RawAppendPayload}
 * (a batch of one or more records with their per-record stamped wire `v` and the
 * batch job_id). The whole-file decode-verify GATE is 007's (R6) — this module
 * provides the frame primitives and the decode-check HOOK ({@link decodeFrames}),
 * not the gate.
 */

import { gzipSync, gunzipSync } from 'node:zlib';
import type { EventEnvelope } from '../../common/contracts/envelope';
import type { ExceptionReason } from '../../common/contracts/exception-reason';

/** 4-byte frame magic: ASCII "RAW1". Guards against reading a non-frame stream. */
export const FRAME_MAGIC = Buffer.from('RAW1', 'ascii');

/** Fixed header size: 4-byte magic + 4-byte big-endian length prefix. */
export const FRAME_HEADER_BYTES = FRAME_MAGIC.length + 4;

/** The one supported codec for a 002 file. Forward-only (next day's file may change it). */
export type RawFileCodec = 'gzip';

/**
 * The record class of an appended entry (bridge 01.5 §3). `body` = a countable
 * event (incl. duplicates); `quarantine` = raw-appended-but-feeds-nothing, marked
 * with the offending {@link ExceptionReason}. Drops are NEVER in the file.
 */
export type RawRecordClass = 'body' | 'quarantine';

/** One record as it lands in the raw file — the full envelope + append metadata. */
export interface RawRecordEntry {
  /** Record class (body / quarantine). */
  cls: RawRecordClass;
  /** The full canonical envelope, verbatim (unknown props preserved) — P-none. */
  envelope: EventEnvelope;
  /** Stamped wire version (absent-on-wire ⇒ 1) for per-record rebuild dispatch. */
  v: number;
  /** Corrected logical day the record was routed to ("YYYY-MM-DD"). */
  corrected_day: string;
  /**
   * Quarantine marker — present iff `cls === 'quarantine'`. The reason name EQUALS
   * an {@link ExceptionReason} (one vocabulary across file and tally, §3).
   */
  marker?: Extract<ExceptionReason, 'quarantined_typed' | 'sealed_late' | 'unknown_kind'>;
}

/** The JSON payload of one framed append (one dequeued batch's records). */
export interface RawAppendPayload {
  /** Batch job id (BullMQ) — carried for rebuild collapse / provenance. */
  job_id: string;
  /** The records appended in this batch. */
  records: RawRecordEntry[];
}

/**
 * Encode one payload into a single self-contained frame: MAGIC + u32 length +
 * gzip(JSON(payload)). The returned Buffer is appended atomically by the writer.
 */
export function encodeFrame(payload: RawAppendPayload, codec: RawFileCodec = 'gzip'): Buffer {
  if (codec !== 'gzip') {
    throw new Error(`[rawfile] unsupported codec "${codec}" — only gzip in 002`);
  }
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const member = gzipSync(json);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(member.length, 0);
  return Buffer.concat([FRAME_MAGIC, len, member]);
}

/** Outcome of decoding a framed stream (the decode-check HOOK, not the gate). */
export interface DecodeResult {
  /** Fully-decoded payloads, in file order. */
  payloads: RawAppendPayload[];
  /** True iff the final frame was truncated (partial tail) — a LOUD warning case. */
  truncatedTail: boolean;
  /** Number of complete frames decoded. */
  frameCount: number;
}

/**
 * Decode every frame in a raw-file buffer (multi-member-safe). This is the
 * decode-check HOOK the seal-time verify (007) and the manual rebuild (T-01.40)
 * build on — it iterates EVERY member and reports a truncated trailing member
 * rather than silently discarding anything.
 *
 * @param buffer the concatenated frame stream.
 * @throws if a NON-TRAILING frame is corrupt (bad magic / undersized member) —
 *         a bad tail is reported via `truncatedTail`, but a bad interior frame is
 *         a hard "fail loud" (§4: fail loud on a bad tail is for truncation; an
 *         interior corruption means the file is not a valid rebuild floor).
 */
export function decodeFrames(buffer: Buffer): DecodeResult {
  const payloads: RawAppendPayload[] = [];
  let offset = 0;
  let truncatedTail = false;

  while (offset < buffer.length) {
    // A frame needs at least the header; a short tail = truncation.
    if (offset + FRAME_HEADER_BYTES > buffer.length) {
      truncatedTail = true;
      break;
    }
    const magic = buffer.subarray(offset, offset + FRAME_MAGIC.length);
    if (!magic.equals(FRAME_MAGIC)) {
      // Interior bad magic → the file is corrupt, not merely truncated. Fail loud.
      throw new Error(`[rawfile] bad frame magic at byte ${offset} — file is not a valid frame stream`);
    }
    const len = buffer.readUInt32BE(offset + FRAME_MAGIC.length);
    const memberStart = offset + FRAME_HEADER_BYTES;
    const memberEnd = memberStart + len;
    if (memberEnd > buffer.length) {
      // The length prefix promises bytes that never arrived → truncated tail.
      truncatedTail = true;
      break;
    }
    const member = buffer.subarray(memberStart, memberEnd);
    let json: Buffer;
    try {
      json = gunzipSync(member);
    } catch (err) {
      // A member that will not gunzip: if it is the last frame, treat as a
      // truncated tail (skip with warning); otherwise fail loud.
      if (memberEnd === buffer.length) {
        truncatedTail = true;
        break;
      }
      throw new Error(`[rawfile] interior gzip member at byte ${offset} failed to decode: ${String(err)}`);
    }
    payloads.push(JSON.parse(json.toString('utf8')) as RawAppendPayload);
    offset = memberEnd;
  }

  return { payloads, truncatedTail, frameCount: payloads.length };
}
