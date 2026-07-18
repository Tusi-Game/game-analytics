import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { connectPostgresOrNull } from '../src/testing/live-infra';
import { EventDayCountEntity } from '../src/database/entities/event-day-count.entity';
import { ExceptionTallyEntity } from '../src/database/entities/exception-tally.entity';

/**
 * PITR RESTORE ROUND-TRIP (T-01.47 DR drill).
 *
 * The classic DR failure is a backup that EXISTS but cannot RESTORE. This drill
 * proves the encrypt→ship→lose→download→decrypt→restore chain that
 * scripts/pitr-backup.sh + scripts/pitr-restore.sh embody, end to end, against the
 * REAL docker stack:
 *
 *   1. write KNOWN results rows (EVENT_DAY_COUNT + EXCEPTION_TALLY) via the app's
 *      own DataSource;
 *   2. BACKUP: `pg_dump` the results tables (inside the postgres container) →
 *      encrypt the dump with SECRET_MASTER_KEY using the EXACT openssl invocation
 *      the scripts use (AES-256-CBC + PBKDF2, iter 200000);
 *   3. SHIP: upload the encrypted dump to the MinIO backup bucket (via the minio
 *      container's `mc`), then DELETE the local copy — the only surviving artifact
 *      is the ciphertext object in object storage (FR-029: a leaked backup is
 *      ciphertext);
 *   4. LOSE: simulate catastrophic loss by TRUNCATE-ing the results tables;
 *   5. RESTORE: download the object back from MinIO, DECRYPT with the key, and
 *      re-import via `psql` inside the container;
 *   6. ASSERT the known rows round-trip byte-for-byte (counts + tallies restored).
 *
 * WHAT IS EXERCISED vs DEFERRED (documented, per the Unit-5 brief): this drills the
 * LOGICAL backup+restore of the results tables through the full encrypt/ship/
 * download/decrypt path — the security-critical + operationally-fragile half. The
 * PHYSICAL pg_basebackup base + continuous-WAL replay (RPO≤WAL-interval) that
 * scripts/pitr-backup.sh runs in the `backup` compose profile requires
 * replication/archive_command config on a dedicated server and is DEFERRED to the
 * scheduled production drill; its encryption boundary is unit-proven in
 * src/security/backup-crypto.spec.ts. A logical dump+restore round-trip is the
 * strongest variant reliably runnable in a test harness and proves the same
 * "backup actually restores" property.
 *
 * SKIPS gracefully when docker / mc / pg_dump / openssl / MinIO are unavailable so
 * a stackless CI run still passes.
 */

const COMPOSE = ['compose'];
const KEY = 'pitr-drill-master-key';
const OPENSSL_ARGS = ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000'];
const BUCKET = 'analytics-backup-drill';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', [...COMPOSE, 'ps', '--format', '{{.Service}}'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Run a command inside a compose service (no TTY), returning stdout as a Buffer. */
function inService(service: string, argv: string[], input?: Buffer): Buffer {
  return execFileSync('docker', [...COMPOSE, 'exec', '-T', service, ...argv], {
    input,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
}

/** Run mc inside the minio container (mc + the server share the container). */
function mc(argv: string[], input?: Buffer): Buffer {
  return inService('minio', ['mc', '--config-dir', '/tmp/.mc-drill', ...argv], input);
}

describe('PITR restore round-trip (DR drill, T-01.47) — live docker stack', () => {
  const docker = dockerAvailable();
  const openssl = opensslAvailable();
  let ds: DataSource | null = null;
  let dir = '';
  let mcReady = false;

  // Unique keys so re-runs never collide with durable rows.
  const game = `pitr-${Math.random().toString(36).slice(2)}`;
  const DAY = '2026-07-18';

  beforeAll(async () => {
    if (!docker || !openssl) {
      return;
    }
    ds = await connectPostgresOrNull();
    if (!ds) {
      return;
    }
    dir = mkdtempSync(join(tmpdir(), 'pitr-drill-'));
    // Configure mc against the in-compose MinIO and ensure the drill bucket exists.
    try {
      mc(['alias', 'set', 'local', 'http://127.0.0.1:9000', 'minioadmin', 'minioadmin']);
      mc(['mb', '--ignore-existing', `local/${BUCKET}`]);
      mcReady = true;
    } catch {
      mcReady = false;
    }
  });

  afterAll(async () => {
    if (ds) {
      // Clean the drill rows so the shared dev DB is left tidy.
      await ds.getRepository(EventDayCountEntity).delete({ gameId: game });
      await ds.getRepository(ExceptionTallyEntity).delete({ gameId: game });
      await ds.destroy();
    }
    if (mcReady) {
      try {
        mc(['rb', '--force', `local/${BUCKET}`]);
      } catch {
        /* best-effort cleanup */
      }
    }
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('known results rows survive backup → encrypt → MinIO → loss → download → decrypt → restore', async () => {
    if (!docker || !openssl || !ds || !mcReady) {
      return; // stack incomplete — skip (proven WITH the stack in the report)
    }

    // ---- 1. WRITE known data --------------------------------------------------
    await ds.getRepository(EventDayCountEntity).save([
      { gameId: game, eventName: 'login', utcDay: DAY, count: '4242' },
      { gameId: game, eventName: 'level_start', utcDay: DAY, count: '99' },
    ]);
    await ds.getRepository(ExceptionTallyEntity).save([
      { gameId: game, utcDay: DAY, reason: 'nameless', count: '40' },
      { gameId: game, utcDay: DAY, reason: 'unparseable', count: '12' },
    ]);

    // ---- 2. BACKUP: pg_dump the results rows for this game (data-only INSERTs) -
    // --column-inserts so the restore is a plain INSERT stream (no COPY / no
    // \restrict meta-commands) — re-importable via psql into the live schema.
    const dumpArgs = [
      'pg_dump',
      '-U',
      'analytics',
      '-d',
      'analytics',
      '--data-only',
      '--column-inserts',
      '--table',
      'event_day_count',
      '--table',
      'exception_tally',
    ];
    const dumpSql = inService('postgres', ['env', 'PGPASSWORD=analytics', ...dumpArgs]);
    // The dump contains ALL games' rows; the round-trip assertion is scoped to our
    // unique game id, so other rows re-inserting is harmless (idempotent PK on
    // conflict is not needed — we TRUNCATE below, then restore the full dump).
    expect(dumpSql.includes(Buffer.from('4242'))).toBe(true); // our known value is in the backup

    const plainDump = join(dir, 'results.sql');
    writeFileSync(plainDump, dumpSql);

    // ---- 2b. ENCRYPT with the EXACT script invocation -------------------------
    const encFile = join(dir, 'results.sql.enc');
    execFileSync(
      'openssl',
      [...OPENSSL_ARGS, '-salt', '-in', plainDump, '-out', encFile, '-pass', 'env:SECRET_MASTER_KEY'],
      { env: { ...process.env, SECRET_MASTER_KEY: KEY } },
    );
    const cipher = readFileSync(encFile);
    // FR-029: the ciphertext must NOT reveal the plaintext SQL / known values.
    expect(cipher.includes(Buffer.from('4242'))).toBe(false);
    expect(cipher.includes(Buffer.from('INSERT INTO'))).toBe(false);

    // ---- 3. SHIP to MinIO, then destroy every LOCAL copy ----------------------
    // Pipe the ciphertext into the minio container and `mc pipe` it to the bucket.
    mc(['pipe', `local/${BUCKET}/results.sql.enc`], cipher);
    rmSync(plainDump); // no plaintext left anywhere on disk
    rmSync(encFile); // even the local ciphertext is gone — only MinIO holds it

    // ---- 4. LOSE: simulate catastrophic loss (TRUNCATE the results tables) ----
    inService('postgres', [
      'env',
      'PGPASSWORD=analytics',
      'psql',
      '-U',
      'analytics',
      '-d',
      'analytics',
      '-c',
      'TRUNCATE event_day_count, exception_tally;',
    ]);
    // Prove the data is really gone before we restore.
    expect(
      await ds.getRepository(EventDayCountEntity).findOne({ where: { gameId: game, eventName: 'login', utcDay: DAY } }),
    ).toBeNull();

    // ---- 5. RESTORE: download from MinIO → decrypt → psql import --------------
    const downloaded = mc(['cat', `local/${BUCKET}/results.sql.enc`]); // pull ciphertext back
    const dlEnc = join(dir, 'dl.sql.enc');
    writeFileSync(dlEnc, downloaded);
    const dlPlain = join(dir, 'dl.sql');
    execFileSync('openssl', [...OPENSSL_ARGS, '-d', '-in', dlEnc, '-out', dlPlain, '-pass', 'env:SECRET_MASTER_KEY'], {
      env: { ...process.env, SECRET_MASTER_KEY: KEY },
    });
    const restoredSql = readFileSync(dlPlain);
    // Decryption round-tripped the SQL back to plaintext (contains our value again).
    expect(restoredSql.includes(Buffer.from('4242'))).toBe(true);
    // Import it via psql inside the container.
    inService(
      'postgres',
      ['env', 'PGPASSWORD=analytics', 'psql', '-U', 'analytics', '-d', 'analytics', '-v', 'ON_ERROR_STOP=1'],
      restoredSql,
    );

    // ---- 6. ASSERT the known rows round-tripped -------------------------------
    const login = await ds
      .getRepository(EventDayCountEntity)
      .findOne({ where: { gameId: game, eventName: 'login', utcDay: DAY } });
    const level = await ds
      .getRepository(EventDayCountEntity)
      .findOne({ where: { gameId: game, eventName: 'level_start', utcDay: DAY } });
    const nameless = await ds
      .getRepository(ExceptionTallyEntity)
      .findOne({ where: { gameId: game, utcDay: DAY, reason: 'nameless' } });
    const unparseable = await ds
      .getRepository(ExceptionTallyEntity)
      .findOne({ where: { gameId: game, utcDay: DAY, reason: 'unparseable' } });

    expect(Number(login?.count)).toBe(4242); // restored from the encrypted MinIO backup
    expect(Number(level?.count)).toBe(99);
    expect(Number(nameless?.count)).toBe(40);
    expect(Number(unparseable?.count)).toBe(12);
  }, 120_000);

  it('a backup encrypted for the drill is NOT decryptable with the wrong key (FR-029)', () => {
    if (!openssl) {
      return;
    }
    const local = mkdtempSync(join(tmpdir(), 'pitr-wrongkey-'));
    try {
      const plain = join(local, 'p.sql');
      const enc = join(local, 'p.sql.enc');
      writeFileSync(plain, Buffer.from('INSERT INTO event_day_count VALUES (secret);'));
      execFileSync('openssl', [...OPENSSL_ARGS, '-salt', '-in', plain, '-out', enc, '-pass', 'env:SECRET_MASTER_KEY'], {
        env: { ...process.env, SECRET_MASTER_KEY: KEY },
      });
      expect(() =>
        execFileSync(
          'openssl',
          [...OPENSSL_ARGS, '-d', '-in', enc, '-out', join(local, 'out.sql'), '-pass', 'env:SECRET_MASTER_KEY'],
          { env: { ...process.env, SECRET_MASTER_KEY: 'the-wrong-key' }, stdio: 'pipe' },
        ),
      ).toThrow();
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  });
});
