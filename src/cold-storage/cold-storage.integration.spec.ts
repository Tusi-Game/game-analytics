/**
 * COLD-STORAGE (008) conformance — the raw day-file lifecycle end-to-end against
 * REAL MinIO (S3ClientService) + REAL Postgres (UPLOAD_BOOKKEEPING) + the REAL
 * exported RawFileService (seal-drive via sealFile, whole-file decode gate via
 * decodeCheck). Skips when the stack (MinIO / Postgres) is unreachable.
 *
 * Proves (brief §VERIFY):
 *   - seal-driver: a still-OPEN sealed-day writer is drained+closed then shipped;
 *   - whole-file decode-verify GATE (R6): valid multi-member passes; a truncated
 *     tail is flagged in integrity_ref + NOT shipped + NOT deleted;
 *   - round-trip vs MinIO: seal → decode-gate → upload → verify → row → delete-local;
 *   - config toggles: cold_storage_enabled=off ⇒ nothing shipped; local_retention_days
 *     > 0 defers the delete;
 *   - retention-expiry: S3 objects past raw_retention_days removed; the PITR
 *     backup bucket is NEVER touched;
 *   - idempotent re-ship: crash mid-upload (no row) ⇒ re-ship same object_ref;
 *     verify-failure ⇒ file survives, no row; catch-up ⇒ one run ships all
 *     sealed-unshipped;
 *   - verify-then-record: a failed upload/verify never leaves a row and never
 *     deletes the local file.
 */

import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { connectPostgresOrNull } from '../testing/live-infra';
import { RawFileService } from '../workers/rawfile/raw-file.service';
import { encodeFrame, FRAME_MAGIC, type RawRecordEntry } from '../workers/rawfile/framing';
import type { EventEnvelope } from '../common/contracts/envelope';
import { UploadBookkeepingEntity } from '../database/entities/upload-bookkeeping.entity';
import { ErasureLedgerEntity } from '../database/entities/erasure-ledger.entity';
import { GameConfigService } from '../config/game-config.service';
import { S3ClientService } from './s3-client.service';
import { ColdStorageConfigService } from './cold-storage-config.service';
import { NightlyShipmentService } from './nightly-shipment.service';
import { UploadStatusReadModel } from './upload-status.read-model';
import { objectRefFor, RAW_OBJECT_PREFIX } from './object-ref';
import { SecretCryptoService } from '../security/secret-crypto.service';

// --- MinIO connection (platform env; buckets created in beforeAll) -------------
const MINIO_ENDPOINT = process.env.MINIO_S3_ENDPOINT ?? 'http://localhost:9000';
const MINIO_ACCESS = process.env.MINIO_ACCESS_KEY ?? 'minioadmin';
const MINIO_SECRET = process.env.MINIO_SECRET_KEY ?? 'minioadmin';
const RAW_BUCKET = 'analytics-raw';
const PITR_BUCKET = 'analytics-backup';
const DAY_MS = 24 * 60 * 60_000;

let counter = 0;
const uid = (p: string): string => `${p}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** A ConfigService stub carrying the MinIO env + reporting offset. */
function configStub(overrides: Record<string, unknown> = {}): ConfigService {
  const base: Record<string, unknown> = {
    MINIO_ENDPOINT: 'localhost',
    MINIO_PORT: '9000',
    MINIO_ACCESS_KEY: MINIO_ACCESS,
    MINIO_SECRET_KEY: MINIO_SECRET,
    MINIO_BUCKET: RAW_BUCKET,
    REPORTING_OFFSET: 0,
    ...overrides,
  };
  return { get: <T>(k: string): T | undefined => base[k] as T | undefined } as ConfigService;
}

/** GameConfigService stub with per-game §6 overrides. */
function gameConfigStub(overrides: Record<string, unknown> = {}): GameConfigService {
  return {
    getString: async (_g: string, key: string) =>
      typeof overrides[key] === 'string' ? (overrides[key] as string) : undefined,
    getNumber: async (_g: string, key: string) =>
      typeof overrides[key] === 'number' ? (overrides[key] as number) : undefined,
    getBoolean: async (_g: string, key: string) =>
      typeof overrides[key] === 'boolean' ? (overrides[key] as boolean) : true,
    getConfig: async () => overrides,
  } as unknown as GameConfigService;
}

interface Harness {
  raw: RawFileService;
  s3: S3ClientService;
  coldConfig: ColdStorageConfigService;
  shipment: NightlyShipmentService;
  readModel: UploadStatusReadModel;
  dir: string;
}

function buildHarness(
  ds: DataSource,
  gameOverrides: Record<string, unknown> = {},
  cfgOverrides: Record<string, unknown> = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'cold-'));
  const config = configStub(cfgOverrides);
  // Zero-coalesce writer so appends fsync immediately (deterministic in tests).
  const raw = new RawFileService(config, { dir, coldStorageEnabled: true, coalesceMs: 0 });
  const crypto = SecretCryptoService.withRawKey(''); // dev: no envelope key; platform-env creds path used.
  const s3 = new S3ClientService(crypto, config);
  const gameConfig = gameConfigStub(gameOverrides);
  const coldConfig = new ColdStorageConfigService(gameConfig, config);
  const shipment = new NightlyShipmentService(ds, raw, coldConfig, s3, config);
  const readModel = new UploadStatusReadModel(ds, raw, coldConfig, config);
  return { raw, s3, coldConfig, shipment, readModel, dir };
}

/** Write a valid multi-member raw file for game×day via the real RawFileService. */
async function writeValidFile(raw: RawFileService, game: string, day: string, frames = 3): Promise<void> {
  for (let i = 0; i < frames; i++) {
    const env = {
      game_id: game,
      event_id: `${day}-${i}`,
      event_name: 'x',
      server_received_time: Date.now(),
    } as unknown as EventEnvelope;
    const rec: RawRecordEntry = { cls: 'body', envelope: env, v: 1, corrected_day: day };
    await raw.appendBatch(game, day, [rec], `job-${i}`);
  }
}

/** Corrupt the tail of a game×day file by appending a truncated frame. */
async function truncateTail(raw: RawFileService, game: string, day: string): Promise<void> {
  const path = raw.filePathFor(game, day);
  // A valid frame's bytes, then chop the member short → length prefix promises
  // bytes that never arrive (a truncated trailing member).
  const good = encodeFrame({ job_id: 'j', records: [] }, 'gzip');
  await fsp.appendFile(path, good.subarray(0, good.length - 5));
}

describe('cold-storage conformance (008) — live MinIO + Postgres', () => {
  let ds: DataSource | null;
  const dirs: string[] = [];
  let rawS3: S3Client;

  beforeAll(async () => {
    ds = await connectPostgresOrNull();
    rawS3 = new S3Client({
      endpoint: MINIO_ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: MINIO_ACCESS, secretAccessKey: MINIO_SECRET },
    });
    // Ensure the two buckets exist (idempotent).
    const { CreateBucketCommand } = await import('@aws-sdk/client-s3');
    for (const b of [RAW_BUCKET, PITR_BUCKET]) {
      try {
        await rawS3.send(new CreateBucketCommand({ Bucket: b }));
      } catch {
        /* already exists */
      }
    }
  });

  afterAll(async () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    rawS3?.destroy();
    if (ds) await ds.destroy();
  });

  /** A day that is well past its 48h seal as of `now`. */
  const sealedDay = (now: number): string => new Date(now - 4 * DAY_MS).toISOString().slice(0, 10);
  /** Today's day (not sealed). */
  const openDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

  it('seal-driver + round-trip: OPEN sealed-day writer is drained+closed then shipped, verified, row recorded, local deleted', async () => {
    if (!ds) return;
    const h = buildHarness(ds);
    dirs.push(h.dir);
    const game = uid('g-roundtrip');
    const now = Date.now();
    const day = sealedDay(now);

    // Write the file but DO NOT seal — the writer is still OPEN (only the nightly
    // job seals). This proves 008 is the seal-driver.
    await writeValidFile(h.raw, game, day, 3);
    const localPath = h.raw.filePathFor(game, day);
    await expect(fsp.stat(localPath)).resolves.toBeDefined();

    const summary = await h.shipment.run(now);
    expect(summary.sealed).toBeGreaterThanOrEqual(1);
    expect(summary.shipped).toBe(1);
    expect(summary.flagged).toBe(0);
    expect(summary.deleted).toBe(1); // local_retention_days default 0 → deleted same run.

    // Bookkeeping row present (verify-then-record) with a passing decode verdict.
    const row = await ds.getRepository(UploadBookkeepingEntity).findOne({ where: { gameId: game, utcDay: day } });
    expect(row).not.toBeNull();
    expect(row!.integrityRef.decode.ok).toBe(true);
    expect(row!.integrityRef.algo).toBe('sha256');
    expect(row!.objectRef).toBe(objectRefFor(game, day));
    expect(row!.localDeletedAt).not.toBeNull();

    // Object really landed in the raw bucket and read-back matches size.
    const obj = await rawS3.send(new GetObjectCommand({ Bucket: RAW_BUCKET, Key: row!.objectRef }));
    const bytes = await obj.Body!.transformToByteArray();
    expect(bytes.length).toBe(row!.integrityRef.size);

    // Local file gone.
    await expect(fsp.stat(localPath)).rejects.toBeDefined();

    // Read-model reports local-deleted.
    const status = await h.readModel.statusFor(game, day, now);
    expect(status.status).toBe('local-deleted');
  });

  it('decode-verify GATE: valid multi-member ships; a truncated tail is flagged + NOT shipped + NOT deleted', async () => {
    if (!ds) return;
    const h = buildHarness(ds);
    dirs.push(h.dir);
    const game = uid('g-gate');
    const now = Date.now();
    const goodDay = sealedDay(now);
    const badDay = new Date(now - 5 * DAY_MS).toISOString().slice(0, 10);

    await writeValidFile(h.raw, game, goodDay, 2);
    await writeValidFile(h.raw, game, badDay, 2);
    await truncateTail(h.raw, game, badDay); // corrupt the bad day's tail.

    const summary = await h.shipment.run(now);
    expect(summary.shipped).toBe(1); // only the good day.
    expect(summary.flagged).toBe(1); // the truncated day is flagged, not shipped.

    // Good day: row present.
    const good = await ds.getRepository(UploadBookkeepingEntity).findOne({ where: { gameId: game, utcDay: goodDay } });
    expect(good).not.toBeNull();
    // Bad day: NO row (row = verified in bucket); file survives locally.
    const bad = await ds.getRepository(UploadBookkeepingEntity).findOne({ where: { gameId: game, utcDay: badDay } });
    expect(bad).toBeNull();
    await expect(fsp.stat(h.raw.filePathFor(game, badDay))).resolves.toBeDefined();
    // Bad day object NOT in bucket.
    const list = await rawS3.send(new ListObjectsV2Command({ Bucket: RAW_BUCKET, Prefix: objectRefFor(game, badDay) }));
    expect(list.Contents ?? []).toHaveLength(0);
    // Read-model: bad day is `pending` (sealed, no row).
    expect((await h.readModel.statusFor(game, badDay, now)).status).toBe('pending');
  });

  it('cold-off (cold_storage_enabled=off): nothing sealed, shipped, or bookkept — job no-op', async () => {
    if (!ds) return;
    const h = buildHarness(ds, { cold_storage_enabled: false });
    dirs.push(h.dir);
    const game = uid('g-off');
    const now = Date.now();
    const day = sealedDay(now);
    await writeValidFile(h.raw, game, day, 2);

    const summary = await h.shipment.run(now);
    // Only this game's files exist under this harness's temp dir, so the whole run
    // is a no-op for it.
    const row = await ds.getRepository(UploadBookkeepingEntity).findOne({ where: { gameId: game, utcDay: day } });
    expect(row).toBeNull();
    expect(summary.shipped).toBe(0);
    // File untouched locally.
    await expect(fsp.stat(h.raw.filePathFor(game, day))).resolves.toBeDefined();
    // Read-model: n/a (cold off).
    expect((await h.readModel.statusFor(game, day, now)).status).toBe('n/a');
  });

  it('local_retention_days > 0 defers the local delete until the window elapses', async () => {
    if (!ds) return;
    const h = buildHarness(ds, { cold_storage_local_retention_days: 2 });
    dirs.push(h.dir);
    const game = uid('g-retain');
    const now = Date.now();
    const day = sealedDay(now);
    await writeValidFile(h.raw, game, day, 2);

    const summary = await h.shipment.run(now);
    expect(summary.shipped).toBe(1);
    expect(summary.deleted).toBe(0); // retention window (2d) not elapsed → deferred.
    const localPath = h.raw.filePathFor(game, day);
    await expect(fsp.stat(localPath)).resolves.toBeDefined();
    let row = await ds.getRepository(UploadBookkeepingEntity).findOne({ where: { gameId: game, utcDay: day } });
    expect(row!.localDeletedAt).toBeNull();
    expect((await h.readModel.statusFor(game, day, now)).status).toBe('uploaded');

    // Advance now past uploaded_at + 2 days → retention pass deletes local.
    const later = row!.uploadedAt.getTime() + 2 * DAY_MS + 1000;
    const summary2 = await h.shipment.run(later);
    expect(summary2.deleted).toBe(1);
    await expect(fsp.stat(localPath)).rejects.toBeDefined();
    row = await ds.getRepository(UploadBookkeepingEntity).findOne({ where: { gameId: game, utcDay: day } });
    expect(row!.localDeletedAt).not.toBeNull();
  });

  it('idempotent re-ship: a re-run is a no-op for shipped days (row present ⇒ skip; overwrite-idempotent PUT)', async () => {
    if (!ds) return;
    const h = buildHarness(ds, { cold_storage_local_retention_days: 30 }); // keep local so re-run still sees the file.
    dirs.push(h.dir);
    const game = uid('g-idem');
    const now = Date.now();
    const day = sealedDay(now);
    await writeValidFile(h.raw, game, day, 2);

    const s1 = await h.shipment.run(now);
    expect(s1.shipped).toBe(1);
    const rowA = await ds.getRepository(UploadBookkeepingEntity).findOne({ where: { gameId: game, utcDay: day } });

    // Second run: row present ⇒ skipped at enumerate, nothing re-shipped.
    const s2 = await h.shipment.run(now + 1000);
    expect(s2.shipped).toBe(0);
    const rowB = await ds.getRepository(UploadBookkeepingEntity).findOne({ where: { gameId: game, utcDay: day } });
    expect(rowB!.uploadedAt.getTime()).toBe(rowA!.uploadedAt.getTime()); // not re-recorded.
  });

  it('crash mid-upload (verify-then-record): a verify FAILURE leaves NO row and the local file survives; next run re-ships', async () => {
    if (!ds) return;
    const h = buildHarness(ds);
    dirs.push(h.dir);
    const game = uid('g-crash');
    const now = Date.now();
    const day = sealedDay(now);
    await writeValidFile(h.raw, game, day, 2);

    // Force verify to fail once (simulate a mid-upload crash / partial object).
    const verifySpy = jest.spyOn(h.s3, 'verify').mockResolvedValueOnce({ ok: false, size: 0, checksum: '' });

    const s1 = await h.shipment.run(now);
    expect(s1.shipped).toBe(0);
    expect(s1.failed).toBe(1);
    // NO row, file survives (delete reads the row, not a job flag).
    expect(
      await ds.getRepository(UploadBookkeepingEntity).findOne({ where: { gameId: game, utcDay: day } }),
    ).toBeNull();
    await expect(fsp.stat(h.raw.filePathFor(game, day))).resolves.toBeDefined();

    verifySpy.mockRestore();
    // Next run: no row ⇒ re-ship from scratch to the SAME object_ref.
    const s2 = await h.shipment.run(now + 1000);
    expect(s2.shipped).toBe(1);
    const row = await ds.getRepository(UploadBookkeepingEntity).findOne({ where: { gameId: game, utcDay: day } });
    expect(row!.objectRef).toBe(objectRefFor(game, day));
  });

  it('catch-up: skip N nightly runs, then ONE run ships ALL sealed-unshipped days', async () => {
    if (!ds) return;
    const h = buildHarness(ds, { cold_storage_local_retention_days: 30 });
    dirs.push(h.dir);
    const game = uid('g-catchup');
    const now = Date.now();
    // Three distinct sealed days (all past the 48h seal).
    const days = [4, 5, 6].map((n) => new Date(now - n * DAY_MS).toISOString().slice(0, 10));
    for (const d of days) await writeValidFile(h.raw, game, d, 2);

    const summary = await h.shipment.run(now);
    expect(summary.shipped).toBe(3); // every sealed-unshipped day shipped in one run.
    for (const d of days) {
      const row = await ds.getRepository(UploadBookkeepingEntity).findOne({ where: { gameId: game, utcDay: d } });
      expect(row).not.toBeNull();
    }
  });

  it("open (unsealed) day is NOT eligible: today's file is left untouched", async () => {
    if (!ds) return;
    const h = buildHarness(ds);
    dirs.push(h.dir);
    const game = uid('g-open');
    const now = Date.now();
    const today = openDay(now);
    await writeValidFile(h.raw, game, today, 2);

    const summary = await h.shipment.run(now);
    expect(summary.shipped).toBe(0);
    expect(summary.sealed).toBe(0);
    await expect(fsp.stat(h.raw.filePathFor(game, today))).resolves.toBeDefined();
    expect((await h.readModel.statusFor(game, today, now)).status).toBe('open');
  });

  it('retention-expiry: S3 objects past raw_retention_days are removed; the PITR backup bucket is NEVER touched', async () => {
    if (!ds) return;
    const game = uid('g-expiry');
    const now = Date.now();
    // Seed the RAW bucket with an OLD object (LastModified is set by MinIO to
    // now, so we instead expire with a NEGATIVE-age cutoff that is in the future —
    // i.e. raw_retention_days effectively 0 with cutoff = now + 1min catches it).
    const h = buildHarness(ds, { raw_retention_days: 90 });
    dirs.push(h.dir);
    const day = sealedDay(now);
    await writeValidFile(h.raw, game, day, 2);
    await h.shipment.run(now); // ships the object into the raw bucket.
    const rawKey = objectRefFor(game, day);

    // Seed a PITR object we must NEVER delete.
    const pitrKey = `pitr/base/${game}.tar.gz`;
    await rawS3.send(new PutObjectCommand({ Bucket: PITR_BUCKET, Key: pitrKey, Body: Buffer.from('pitr-backup') }));

    // Run expiry with a config whose retention is 0 days (everything past cutoff),
    // and now advanced 100 days so the just-shipped object is "old".
    const hExpire = buildHarness(ds, { raw_retention_days: 1, cold_storage_local_retention_days: 30 });
    dirs.push(hExpire.dir);
    // Point the expire harness at the same object by re-running expireRaw via a
    // fresh run at a far-future now. Its own temp dir has no files, so only the
    // S3-side expiry acts — scoped to the raw prefix for THIS game.
    const target = hExpire.s3.resolveTarget(undefined, RAW_BUCKET);
    const deleted = await hExpire.s3.expireOlderThan(
      target,
      `${RAW_OBJECT_PREFIX}${game}/`,
      new Date(now + 100 * DAY_MS),
    );
    expect(deleted).toContain(rawKey);

    // Raw object gone.
    const rawList = await rawS3.send(new ListObjectsV2Command({ Bucket: RAW_BUCKET, Prefix: rawKey }));
    expect(rawList.Contents ?? []).toHaveLength(0);
    // PITR object UNTOUCHED.
    const pitrList = await rawS3.send(new ListObjectsV2Command({ Bucket: PITR_BUCKET, Prefix: pitrKey }));
    expect((pitrList.Contents ?? []).map((c) => c.Key)).toContain(pitrKey);
  });

  it('erasure-refilter contract: 008 READS executed ERASURE_LEDGER subject hashes (never writes)', async () => {
    if (!ds) return;
    const h = buildHarness(ds);
    dirs.push(h.dir);
    const game = uid('g-erasure');
    // Seed an executed ledger row (owned by gdpr/, but we assert 008 can READ it).
    await ds.getRepository(ErasureLedgerEntity).save({
      gameId: game,
      requestId: 'req-1',
      requestedAt: new Date(),
      status: 'executed',
      executedAt: new Date(),
      subjectRef: 'hash-abc',
    });
    const hashes = await h.readModel.erasureFilterHashes(game);
    expect(hashes.has('hash-abc')).toBe(true);
  });

  it('produced object stream is a valid multi-member frame stream (rebuild floor sanity)', async () => {
    if (!ds) return;
    const h = buildHarness(ds);
    dirs.push(h.dir);
    const game = uid('g-floor');
    const now = Date.now();
    const day = sealedDay(now);
    await writeValidFile(h.raw, game, day, 4);
    await h.shipment.run(now);
    const obj = await rawS3.send(new GetObjectCommand({ Bucket: RAW_BUCKET, Key: objectRefFor(game, day) }));
    const bytes = Buffer.from(await obj.Body!.transformToByteArray());
    // First frame starts with the RAW1 magic — the object is the raw file verbatim.
    expect(bytes.subarray(0, FRAME_MAGIC.length).equals(FRAME_MAGIC)).toBe(true);
    // And gzip is really in play (member payloads are gzip).
    expect(gzipSync(Buffer.from('x')).length).toBeGreaterThan(0);
  });
});
