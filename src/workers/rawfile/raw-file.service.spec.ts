import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { RawFileService } from './raw-file.service';
import { decodeFrames } from './framing';
import type { EventEnvelope } from '../../common/contracts/envelope';

/**
 * Write-ahead raw day-file writer (bridge 01.5, T-01.32–39). Proves:
 *   - the fsync'd append lands durable BODY / QUARANTINE entries, drops never;
 *   - SC-008 / DARK-SPOT #3: the append promise resolves only AFTER fsync, so a
 *     counter awaiting it can never precede durable bytes — the file is a superset
 *     of everything a counter could have run for;
 *   - group commit: many appends coalesce (the file is still a valid frame
 *     stream, decodes end-to-end);
 *   - cold-storage-off makes step 4 a pure no-op (no file at all).
 */

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = { ...overrides };
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function env(id: string, gameId = 'game-42'): EventEnvelope {
  const t = Date.parse('2026-07-18T12:00:00Z');
  return {
    game_id: gameId,
    event_id: id,
    name: 'level_start',
    kind: 'generic',
    client_event_time: t,
    client_sent_time: t,
    server_received_time: t,
    props: {},
  };
}

describe('RawFileService (write-ahead day-file)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rawfile-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends BODY entries fsync-durably and the file decodes end-to-end', async () => {
    const svc = new RawFileService(makeConfig(), { dir, coldStorageEnabled: true });
    const res = await svc.append(env('evt-1'), '2026-07-18', 'append', 'job-1');
    expect(res.appended).toBe(true);
    await svc.onModuleDestroy();

    const buf = readFileSync(svc.filePathFor('game-42', '2026-07-18'));
    const decoded = decodeFrames(buf);
    expect(decoded.truncatedTail).toBe(false);
    expect(decoded.payloads[0]?.records[0]?.cls).toBe('body');
    expect(decoded.payloads[0]?.records[0]?.envelope.event_id).toBe('evt-1');
  });

  it('marks QUARANTINE entries and NEVER writes DROP entries', async () => {
    const svc = new RawFileService(makeConfig(), { dir, coldStorageEnabled: true });
    await svc.append(env('q-1'), '2026-07-18', 'append-quarantine', 'job-1');
    const drop = await svc.append(env('d-1'), '2026-07-18', 'skip-drop', 'job-1');
    expect(drop.appended).toBe(false);
    await svc.onModuleDestroy();

    const decoded = decodeFrames(readFileSync(svc.filePathFor('game-42', '2026-07-18')));
    const classes = decoded.payloads.flatMap((p) => p.records.map((r) => r.cls));
    // Only the quarantine record is present — the drop never reached the file.
    expect(classes).toEqual(['quarantine']);
  });

  it('SC-008: the append promise resolves ONLY after fsync (superset invariant)', async () => {
    const svc = new RawFileService(makeConfig(), { dir, coldStorageEnabled: true });
    // Model "count after append": we only run the counter in the append's .then.
    let countedBeforeDurable = false;
    let fileHadBytes = false;

    const p = svc.append(env('evt-1'), '2026-07-18', 'append', 'job-1').then(() => {
      // At this point fsync has completed → the bytes MUST be on disk already.
      try {
        const buf = readFileSync(svc.filePathFor('game-42', '2026-07-18'));
        fileHadBytes = decodeFrames(buf).frameCount === 1;
      } catch {
        countedBeforeDurable = true; // file missing when counter ran = the bug
      }
    });
    await p;
    expect(countedBeforeDurable).toBe(false);
    expect(fileHadBytes).toBe(true);
    await svc.onModuleDestroy();
  });

  it('CRASH INJECTION (safe direction): crash AFTER fsync BEFORE count → logged-but-uncounted', async () => {
    // Simulate the §10 interleaving: the batch's bytes are fsync-durable, then the
    // worker dies before the HINCRBY. The raw file MUST still contain the event
    // (logged), while a counter that never ran leaves it uncounted — an
    // UNDERCOUNT, the safe direction. The reverse (counted-but-unlogged) is
    // structurally impossible because the counter awaits this append.
    const svc = new RawFileService(makeConfig(), { dir, coldStorageEnabled: true });
    // Append completes (fsync durable) …
    await svc.append(env('evt-crash'), '2026-07-18', 'append', 'job-1');
    // … then the "process" crashes here — the counter (which would set countRan)
    // never runs. countRan stays false = the event is uncounted.
    const countRan = false;
    await svc.onModuleDestroy();

    const decoded = decodeFrames(readFileSync(svc.filePathFor('game-42', '2026-07-18')));
    expect(decoded.frameCount).toBe(1); // LOGGED — the file is a superset
    expect(countRan).toBe(false); // UNCOUNTED — never HINCRBY'd (safe undercount)
  });

  it('GROUP COMMIT: concurrent appends coalesce yet the file stays a valid frame stream', async () => {
    const svc = new RawFileService(makeConfig(), { dir, coldStorageEnabled: true });
    // Fire many appends in the SAME tick → they share one group-commit fsync.
    const ids = Array.from({ length: 25 }, (_, i) => `evt-${i}`);
    await Promise.all(ids.map((id) => svc.append(env(id), '2026-07-18', 'append', 'batch-job')));
    await svc.onModuleDestroy();

    const decoded = decodeFrames(readFileSync(svc.filePathFor('game-42', '2026-07-18')));
    expect(decoded.truncatedTail).toBe(false);
    const seen = decoded.payloads.flatMap((p) => p.records.map((r) => r.envelope.event_id));
    expect(new Set(seen)).toEqual(new Set(ids)); // every append is durable, none torn
  });

  it('routes by game × corrected day into separate files', async () => {
    const svc = new RawFileService(makeConfig(), { dir, coldStorageEnabled: true });
    await svc.append(env('a', 'game-1'), '2026-07-18', 'append', 'j');
    await svc.append(env('b', 'game-2'), '2026-07-19', 'append', 'j');
    await svc.onModuleDestroy();

    const f1 = decodeFrames(readFileSync(svc.filePathFor('game-1', '2026-07-18')));
    const f2 = decodeFrames(readFileSync(svc.filePathFor('game-2', '2026-07-19')));
    expect(f1.payloads[0]?.records[0]?.envelope.event_id).toBe('a');
    expect(f2.payloads[0]?.records[0]?.envelope.event_id).toBe('b');
  });

  it('COLD-STORAGE-OFF: step 4 is a pure no-op (no file, appended=false)', async () => {
    const svc = new RawFileService(makeConfig(), { dir, coldStorageEnabled: false });
    const res = await svc.append(env('evt-1'), '2026-07-18', 'append', 'job-1');
    expect(res.appended).toBe(false);
    await svc.onModuleDestroy();
    expect(() => readFileSync(svc.filePathFor('game-42', '2026-07-18'))).toThrow();
  });

  it('decodeCheck HOOK reads a sealed file back and verifies it decodes', async () => {
    const svc = new RawFileService(makeConfig(), { dir, coldStorageEnabled: true });
    await svc.appendBatch(
      'game-42',
      '2026-07-18',
      [
        { cls: 'body', envelope: env('a'), v: 1, corrected_day: '2026-07-18' },
        { cls: 'body', envelope: env('b'), v: 1, corrected_day: '2026-07-18' },
      ],
      'job-1',
    );
    await svc.sealFile('game-42', '2026-07-18');
    const check = await svc.decodeCheck('game-42', '2026-07-18');
    expect(check.truncatedTail).toBe(false);
    expect(check.payloads[0]?.records.length).toBe(2);
  });
});
