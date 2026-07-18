import { encodeFrame, decodeFrames, FRAME_MAGIC, type RawAppendPayload } from './framing';
import type { EventEnvelope } from '../../common/contracts/envelope';

/**
 * Per-append framing (bridge 01.5 §4). Proves the multi-member-safe decode HOOK:
 * every gzip member decodes independently, a truncated trailing member is
 * detectable (not silently dropped), and an interior corruption fails loud.
 */

function env(id: string): EventEnvelope {
  const t = Date.parse('2026-07-18T12:00:00Z');
  return {
    game_id: 'game-42',
    event_id: id,
    name: 'level_start',
    kind: 'generic',
    client_event_time: t,
    client_sent_time: t,
    server_received_time: t,
    props: { level: 1 },
  };
}

function payload(jobId: string, ids: string[]): RawAppendPayload {
  return {
    job_id: jobId,
    records: ids.map((id) => ({ cls: 'body' as const, envelope: env(id), v: 1, corrected_day: '2026-07-18' })),
  };
}

describe('raw-file framing', () => {
  it('round-trips a single frame', () => {
    const frame = encodeFrame(payload('job-1', ['evt-1']));
    expect(frame.subarray(0, 4).equals(FRAME_MAGIC)).toBe(true);
    const decoded = decodeFrames(frame);
    expect(decoded.truncatedTail).toBe(false);
    expect(decoded.frameCount).toBe(1);
    expect(decoded.payloads[0]?.records[0]?.envelope.event_id).toBe('evt-1');
  });

  it('is MULTI-MEMBER-SAFE: iterates EVERY concatenated member (never discards after the first)', () => {
    const stream = Buffer.concat([
      encodeFrame(payload('job-1', ['a'])),
      encodeFrame(payload('job-2', ['b', 'c'])),
      encodeFrame(payload('job-3', ['d'])),
    ]);
    const decoded = decodeFrames(stream);
    expect(decoded.frameCount).toBe(3);
    const allIds = decoded.payloads.flatMap((p) => p.records.map((r) => r.envelope.event_id));
    expect(allIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('flags a TRUNCATED trailing member instead of silently dropping it', () => {
    const good = encodeFrame(payload('job-1', ['a']));
    const partial = encodeFrame(payload('job-2', ['b'])).subarray(0, 10); // cut mid-member
    const decoded = decodeFrames(Buffer.concat([good, partial]));
    // The complete leading frame is kept; the truncated tail is reported, not lost.
    expect(decoded.frameCount).toBe(1);
    expect(decoded.truncatedTail).toBe(true);
    expect(decoded.payloads[0]?.records[0]?.envelope.event_id).toBe('a');
  });

  it('flags a truncated header-only tail', () => {
    const good = encodeFrame(payload('job-1', ['a']));
    const decoded = decodeFrames(Buffer.concat([good, Buffer.from([0x52, 0x41])])); // 2 stray bytes
    expect(decoded.frameCount).toBe(1);
    expect(decoded.truncatedTail).toBe(true);
  });

  it('FAILS LOUD on an interior corrupt frame (bad magic mid-stream)', () => {
    const a = encodeFrame(payload('job-1', ['a']));
    const b = encodeFrame(payload('job-2', ['b']));
    // Corrupt the magic of the SECOND (interior) frame, then append a valid third.
    const corrupted = Buffer.from(b);
    corrupted[0] = 0x00;
    const c = encodeFrame(payload('job-3', ['c']));
    expect(() => decodeFrames(Buffer.concat([a, corrupted, c]))).toThrow(/bad frame magic/);
  });
});
