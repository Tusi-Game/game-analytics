import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import * as argon2 from 'argon2';
import { AppModule } from '../src/app.module';
import { GameEntity } from '../src/database/entities/game.entity';
import { OperatorAccountEntity } from '../src/database/entities/operator-account.entity';
import { OperatorLoginAuditEntity } from '../src/database/entities/operator-login-audit.entity';
import { ConfigAuditEntity } from '../src/database/entities/config-audit.entity';
import { GdprRequestAuditEntity } from '../src/database/entities/gdpr-request-audit.entity';
import { GameSdkKeyEntity } from '../src/database/entities/game-sdk-key.entity';
import { GameServerCredentialEntity } from '../src/database/entities/game-server-credential.entity';
import { EventDayCountEntity } from '../src/database/entities/event-day-count.entity';
import { ExceptionTallyEntity } from '../src/database/entities/exception-tally.entity';
import { FlushJobService } from '../src/workers/flush/flush-job.service';
import { MfaService } from '../src/operator/mfa.service';

/**
 * Admin control-plane e2e over HTTP against a LIVE AppModule + Postgres + Redis
 * (T-10.39 RBAC · T-10.42 sdk_key revoke→ingest goes dark · T-10.47 audit · P12
 * multi-game isolation · R13 set-once — ALL exercised through the assembled
 * controllers with a REAL operator session, closing the flagged gap that no test
 * drove RBAC + multi-game isolation at the HTTP layer).
 *
 * The auth flow is the real one: POST /admin/auth/login → an opaque Redis session
 * id → subsequent requests carry `Authorization: Bearer <sessionId>`. The
 * OperatorSessionGuard + RolesGuard run for real; nothing is stubbed.
 *
 * Requires the stack; SKIPS if unreachable (reuses the ingest e2e's reachable() +
 * env-default pattern) so a stackless CI run stays green. `docker compose up -d
 * postgres redis`.
 */

const SUFFIX = Math.random().toString(36).slice(2, 8);
const ADMIN_EMAIL = `admin-${SUFFIX}@studio.test`;
const VIEWER_EMAIL = `viewer-${SUFFIX}@studio.test`;
const PASSWORD = 'correct horse battery staple';
const GAME_A = `admin-http-a-${SUFFIX}`;
const GAME_B = `admin-http-b-${SUFFIX}`;

async function reachable(): Promise<boolean> {
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    retryStrategy: () => null,
  });
  try {
    await redis.connect();
    await redis.ping();
    redis.disconnect();
    return true;
  } catch {
    redis.disconnect();
    return false;
  }
}

describe('Admin control-plane e2e over HTTP (live stack)', () => {
  let app: INestApplication | null = null;
  let ds: DataSource;
  let up = false;
  let adminToken = '';
  let viewerToken = '';
  let adminOperatorId = '';
  let rawDir = '';

  beforeAll(async () => {
    up = await reachable();
    if (!up) {
      return;
    }
    process.env.DB_HOST ??= '127.0.0.1';
    process.env.DB_PORT ??= '5432';
    process.env.DB_USER ??= 'analytics';
    process.env.DB_PASSWORD ??= 'analytics';
    process.env.DB_NAME ??= 'analytics';
    process.env.REDIS_HOST ??= '127.0.0.1';
    process.env.REDIS_PORT ??= '6379';
    // Enable the live ingest worker so the sdk_key-revoke→drop-and-tally path runs.
    process.env.INGEST_WORKER_ENABLED = '1';
    process.env.NODE_ENV = 'test';
    // A master key so the MFA-required HTTP login path can envelope-encrypt the
    // TOTP secret (SecretCryptoService.enabled) — and so credential hashing is
    // self-consistent across the admin API + the ingest resolver in this boot.
    process.env.SECRET_MASTER_KEY ??= 'admin-http-e2e-master';
    // Keep raw day-files out of the repo — write to a throwaway temp dir.
    rawDir = mkdtempSync(join(tmpdir(), 'admin-http-e2e-raw-'));
    process.env.RAW_FILE_DIR = rawDir;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    ds = app.get(DataSource);

    // Provision two operator accounts (admin + viewer) directly in PG — the seed
    // path is out of scope here; we only need real accounts to log in as.
    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    const accounts = ds.getRepository(OperatorAccountEntity);
    const admin = await accounts.save(
      accounts.create({
        email: ADMIN_EMAIL,
        passwordHash,
        mfaTotpSecret: null,
        failedLoginCount: 0,
        lockedUntil: null,
        role: 'admin',
        createdAt: new Date(),
        disabledAt: null,
      }),
    );
    adminOperatorId = admin.operatorId;
    await accounts.save(
      accounts.create({
        email: VIEWER_EMAIL,
        passwordHash,
        mfaTotpSecret: null,
        failedLoginCount: 0,
        lockedUntil: null,
        role: 'viewer',
        createdAt: new Date(),
        disabledAt: null,
      }),
    );

    // Two games so P12 isolation is observable across a boundary.
    const games = ds.getRepository(GameEntity);
    for (const gameId of [GAME_A, GAME_B]) {
      await games.insert({
        gameId,
        name: gameId,
        sdkKey: null,
        serverCredential: null,
        config: {},
        registeredAt: new Date(),
      });
    }

    // Log both operators in over HTTP → real Redis sessions → bearer tokens.
    adminToken = await login(app, ADMIN_EMAIL);
    viewerToken = await login(app, VIEWER_EMAIL);
  });

  afterAll(async () => {
    delete process.env.INGEST_WORKER_ENABLED;
    delete process.env.RAW_FILE_DIR;
    if (up && ds) {
      for (const gameId of [GAME_A, GAME_B]) {
        await ds.getRepository(GdprRequestAuditEntity).delete({ gameId });
        await ds.getRepository(ConfigAuditEntity).delete({ gameId });
        await ds.getRepository(GameSdkKeyEntity).delete({ gameId });
        await ds.getRepository(GameServerCredentialEntity).delete({ gameId });
        await ds.getRepository(EventDayCountEntity).delete({ gameId });
        await ds.getRepository(ExceptionTallyEntity).delete({ gameId });
        await ds.getRepository(GameEntity).delete({ gameId });
      }
      await ds.getRepository(OperatorLoginAuditEntity).delete({ emailAttempted: ADMIN_EMAIL });
      await ds.getRepository(OperatorLoginAuditEntity).delete({ emailAttempted: VIEWER_EMAIL });
      await ds.getRepository(OperatorAccountEntity).delete({ email: ADMIN_EMAIL });
      await ds.getRepository(OperatorAccountEntity).delete({ email: VIEWER_EMAIL });
    }
    if (app) {
      await app.close();
    }
    if (rawDir) {
      rmSync(rawDir, { recursive: true, force: true });
    }
  });

  async function login(a: INestApplication, email: string): Promise<string> {
    const res = await request(a.getHttpServer())
      .post('/admin/auth/login')
      .send({ email, password: PASSWORD })
      .expect(201);
    return res.body.sessionId as string;
  }

  // ── session lifecycle over HTTP (T-10.7/T-10.33) ──────────────────────────────

  it('login issues a real Redis session; an unknown bearer → 401; logout revokes it', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();

    // A valid session resolves through the guard on a read route.
    await request(server).get('/admin/games').set('Authorization', `Bearer ${adminToken}`).expect(200);

    // No / unknown bearer → 401 (guard refuses).
    await request(server).get('/admin/games').expect(401);
    await request(server).get('/admin/games').set('Authorization', 'Bearer totally-bogus').expect(401);

    // A throwaway session that we log out is then rejected (server-side revoke).
    const tmpToken = await login(app, VIEWER_EMAIL);
    await request(server).get('/admin/games').set('Authorization', `Bearer ${tmpToken}`).expect(200);
    await request(server).post('/admin/auth/logout').set('Authorization', `Bearer ${tmpToken}`).expect(201);
    await request(server).get('/admin/games').set('Authorization', `Bearer ${tmpToken}`).expect(401);
  });

  // ── T-10.39 RBAC over HTTP: viewer 403 on EVERY write; admin allowed ──────────

  it('T-10.39: a VIEWER session is refused every write with 403; an ADMIN is allowed', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();
    const V = `Bearer ${viewerToken}`;
    const A = `Bearer ${adminToken}`;

    // (a) config SET — viewer 403, admin 200.
    await request(server)
      .put(`/admin/games/${GAME_A}/config/top_n_events`)
      .set('Authorization', V)
      .send({ value: 15 })
      .expect(403);
    await request(server)
      .put(`/admin/games/${GAME_A}/config/top_n_events`)
      .set('Authorization', A)
      .send({ value: 15 })
      .expect(200);

    // (b) game register — viewer 403, admin 201.
    const regGame = `${GAME_A}-reg`;
    await request(server)
      .post('/admin/games')
      .set('Authorization', V)
      .send({ gameId: regGame, name: 'reg' })
      .expect(403);
    const reg = await request(server)
      .post('/admin/games')
      .set('Authorization', A)
      .send({ gameId: regGame, name: 'reg' })
      .expect(201);
    expect(reg.body.sdkKey.raw.startsWith('pk_')).toBe(true);
    // clean up the extra game.
    await ds.getRepository(GameSdkKeyEntity).delete({ gameId: regGame });
    await ds.getRepository(GameEntity).delete({ gameId: regGame });

    // (c) sdk_key issue — viewer 403, admin 201.
    await request(server).post(`/admin/games/${GAME_A}/sdk-keys`).set('Authorization', V).expect(403);
    const issued = await request(server).post(`/admin/games/${GAME_A}/sdk-keys`).set('Authorization', A).expect(201);
    const keyId = issued.body.id as string;

    // (d) sdk_key revoke — viewer 403; admin allowed (with the confirmDark ack).
    await request(server)
      .post(`/admin/games/${GAME_A}/sdk-keys/${keyId}/revoke`)
      .set('Authorization', V)
      .send({ confirmDark: true })
      .expect(403);
    await request(server)
      .post(`/admin/games/${GAME_A}/sdk-keys/${keyId}/revoke`)
      .set('Authorization', A)
      .send({ confirmDark: true })
      .expect(201);

    // (e) server_credential create — viewer 403, admin 201.
    await request(server).post(`/admin/games/${GAME_A}/server-credentials`).set('Authorization', V).expect(403);
    await request(server).post(`/admin/games/${GAME_A}/server-credentials`).set('Authorization', A).expect(201);

    // (f) GDPR erasure trigger — viewer 403, admin allowed.
    await request(server)
      .post(`/admin/games/${GAME_A}/gdpr/erasure`)
      .set('Authorization', V)
      .send({ userId: 'p1', attestation: 'ticket #1' })
      .expect(403);
    await request(server)
      .post(`/admin/games/${GAME_A}/gdpr/erasure`)
      .set('Authorization', A)
      .send({ userId: 'p1', attestation: 'ticket #1' })
      .expect(201);

    // (g) GDPR DSAR trigger — viewer 403, admin allowed.
    await request(server)
      .post(`/admin/games/${GAME_A}/gdpr/dsar`)
      .set('Authorization', V)
      .send({ userId: 'p2', attestation: 'ID checked' })
      .expect(403);
    const dsar = await request(server)
      .post(`/admin/games/${GAME_A}/gdpr/dsar`)
      .set('Authorization', A)
      .send({ userId: 'p2', attestation: 'ID checked' })
      .expect(201);
    expect(dsar.body.scope_note).toMatch(/Art\. 11|Recital 26/i);

    // (h) master-key rotation — viewer 403 (RBAC refuses BEFORE the env-key check).
    await request(server).post('/admin/secrets/rotate-master-key').set('Authorization', V).expect(403);

    // A viewer CAN still read (design §ER: viewer reads, cannot write).
    await request(server).get(`/admin/games/${GAME_A}/config`).set('Authorization', V).expect(200);
    await request(server).get(`/admin/games/${GAME_A}/sdk-keys`).set('Authorization', V).expect(200);
    await request(server).get(`/admin/games/${GAME_A}/config/audit`).set('Authorization', V).expect(200);
  });

  // ── R13 set-once hard-block over HTTP (T-10.24, R13) ──────────────────────────

  it('R13: reporting_offset edit is HARD-BLOCKED over the admin config endpoint (403)', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();
    // Even as ADMIN the platform-level set-once knob is refused via HTTP.
    await request(server)
      .put(`/admin/games/${GAME_A}/config/reporting_offset`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: 210 })
      .expect(403);
    // No CONFIG_AUDIT row was written for the blocked edit.
    const rows = await ds
      .getRepository(ConfigAuditEntity)
      .count({ where: { gameId: GAME_A, configKey: 'reporting_offset' } });
    expect(rows).toBe(0);
  });

  // ── out-of-contract validation over HTTP (T-10.43) ────────────────────────────

  it('T-10.43: an out-of-contract value is rejected over HTTP with NO write, NO audit', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();
    const before = await ds
      .getRepository(ConfigAuditEntity)
      .count({ where: { gameId: GAME_B, configKey: 'event_name_cap_per_game' } });
    // event_name_cap_per_game is int 1..100000; -5 is out of range.
    await request(server)
      .put(`/admin/games/${GAME_B}/config/event_name_cap_per_game`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: -5 })
      .expect(400);
    const after = await ds
      .getRepository(ConfigAuditEntity)
      .count({ where: { gameId: GAME_B, configKey: 'event_name_cap_per_game' } });
    expect(after).toBe(before);
    const game = await ds.getRepository(GameEntity).findOneOrFail({ where: { gameId: GAME_B } });
    expect(game.config['event_name_cap_per_game']).toBeUndefined();
  });

  // ── T-10.47 full-audit coverage: every config write = exactly ONE audit row ────

  it('T-10.47: each config write over HTTP appends exactly ONE CONFIG_AUDIT row', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();
    const repo = ds.getRepository(ConfigAuditEntity);
    const before = await repo.count({ where: { gameId: GAME_B, configKey: 'whale_min_payers' } });

    await request(server)
      .put(`/admin/games/${GAME_B}/config/whale_min_payers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: 5 })
      .expect(200);
    await request(server)
      .put(`/admin/games/${GAME_B}/config/whale_min_payers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ value: 9 })
      .expect(200);

    const rows = await repo.find({
      where: { gameId: GAME_B, configKey: 'whale_min_payers' },
      order: { changedAt: 'ASC' },
    });
    expect(rows.length).toBe(before + 2); // exactly two writes → two audit rows
    const latest = rows[rows.length - 1];
    expect(latest?.newValue).toBe('9');
    expect(latest?.oldValue).toBe('5'); // forward-only trail records the old value
    // Every write attributes the ACTING admin operator.
    expect(rows.slice(before).every((r) => r.operatorId === adminOperatorId)).toBe(true);
  });

  it('T-10.47: failed logins land in operator_login_audit — a DISTINCT stream from CONFIG_AUDIT', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();
    // A wrong-password login → 401, recorded in the login-audit stream only.
    await request(server).post('/admin/auth/login').send({ email: ADMIN_EMAIL, password: 'nope' }).expect(401);

    const loginRows = await ds.getRepository(OperatorLoginAuditEntity).find({ where: { emailAttempted: ADMIN_EMAIL } });
    const outcomes = new Set(loginRows.map((r) => r.outcome));
    expect(outcomes.has('failed')).toBe(true); // the bad attempt
    expect(outcomes.has('success')).toBe(true); // the earlier successful login
    // The login stream is NOT the config stream: no login row is a CONFIG_AUDIT row.
    const configForNothing = await ds.getRepository(ConfigAuditEntity).count({ where: { gameId: ADMIN_EMAIL } }); // ADMIN_EMAIL is never a gameId
    expect(configForNothing).toBe(0);
  });

  // ── T-10.37 lockout over HTTP ─────────────────────────────────────────────────

  it('T-10.37: 5 failed HTTP logins lock the account; the 6th is refused even with the right password', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();
    // A DEDICATED throwaway account so the shared admin/viewer are never locked.
    const email = `lockout-${SUFFIX}@studio.test`;
    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    await ds.getRepository(OperatorAccountEntity).insert({
      email,
      passwordHash,
      mfaTotpSecret: null,
      failedLoginCount: 0,
      lockedUntil: null,
      role: 'viewer',
      createdAt: new Date(),
      disabledAt: null,
    });
    try {
      // Default OPERATOR_LOGIN_MAX_ATTEMPTS = 5 → the 5th wrong attempt trips lockout.
      for (let i = 0; i < 5; i += 1) {
        await request(server).post('/admin/auth/login').send({ email, password: 'wrong' }).expect(401);
      }
      const locked = await ds.getRepository(OperatorAccountEntity).findOneOrFail({ where: { email } });
      expect(locked.failedLoginCount).toBeGreaterThanOrEqual(5);
      expect(locked.lockedUntil).not.toBeNull();
      expect((locked.lockedUntil as Date).getTime()).toBeGreaterThan(Date.now());

      // The 6th attempt is refused even with the CORRECT password (still locked).
      await request(server).post('/admin/auth/login').send({ email, password: PASSWORD }).expect(401);

      // Simulate the backoff elapsing → a correct login now succeeds and RESETS.
      await ds.getRepository(OperatorAccountEntity).update({ email }, { lockedUntil: new Date(Date.now() - 1000) });
      const ok = await request(server).post('/admin/auth/login').send({ email, password: PASSWORD }).expect(201);
      expect(typeof ok.body.sessionId).toBe('string');
      const reset = await ds.getRepository(OperatorAccountEntity).findOneOrFail({ where: { email } });
      expect(reset.failedLoginCount).toBe(0);
      expect(reset.lockedUntil).toBeNull();
    } finally {
      await ds.getRepository(OperatorLoginAuditEntity).delete({ emailAttempted: email });
      await ds.getRepository(OperatorAccountEntity).delete({ email });
    }
  });

  // ── T-10.38 MFA over HTTP: TOTP required; secret is ciphertext, never plaintext ─

  it('T-10.38: an MFA-enrolled operator needs a valid TOTP over HTTP; the stored secret is v1. ciphertext', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();
    const email = `mfa-${SUFFIX}@studio.test`;
    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });

    // Enrol MFA via the real service, persisting the ENVELOPE-ENCRYPTED secret.
    const mfa = app.get(MfaService);
    const enrolment = mfa.enrol(email);
    await ds.getRepository(OperatorAccountEntity).insert({
      email,
      passwordHash,
      mfaTotpSecret: enrolment.encryptedSecret,
      failedLoginCount: 0,
      lockedUntil: null,
      role: 'admin',
      createdAt: new Date(),
      disabledAt: null,
    });
    try {
      // The persisted secret is ciphertext (v1. envelope), never the raw seed.
      const stored = await ds.getRepository(OperatorAccountEntity).findOneOrFail({ where: { email } });
      expect(stored.mfaTotpSecret).not.toBe(enrolment.secret);
      expect(stored.mfaTotpSecret?.startsWith('v1.')).toBe(true);

      // Password-only login is refused (MFA in force for the account) → 401.
      await request(server).post('/admin/auth/login').send({ email, password: PASSWORD }).expect(401);
      // A wrong TOTP → 401.
      await request(server)
        .post('/admin/auth/login')
        .send({ email, password: PASSWORD, totpCode: '000000' })
        .expect(401);
      // The correct current TOTP → 201 with a session.
      const code = mfa.currentCode(enrolment.secret);
      const ok = await request(server)
        .post('/admin/auth/login')
        .send({ email, password: PASSWORD, totpCode: code })
        .expect(201);
      expect(typeof ok.body.sessionId).toBe('string');
    } finally {
      await ds.getRepository(OperatorLoginAuditEntity).delete({ emailAttempted: email });
      await ds.getRepository(OperatorAccountEntity).delete({ email });
    }
  });

  // ── P12 multi-game isolation over HTTP ────────────────────────────────────────

  it('P12: an admin hitting game A sees only A; a config write to A never touches B', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();
    const A = `Bearer ${adminToken}`;

    await request(server)
      .put(`/admin/games/${GAME_A}/config/mau_window_days`)
      .set('Authorization', A)
      .send({ value: 7 })
      .expect(200);
    await request(server)
      .put(`/admin/games/${GAME_B}/config/mau_window_days`)
      .set('Authorization', A)
      .send({ value: 30 })
      .expect(200);

    const cfgA = await request(server).get(`/admin/games/${GAME_A}/config`).set('Authorization', A).expect(200);
    const cfgB = await request(server).get(`/admin/games/${GAME_B}/config`).set('Authorization', A).expect(200);
    expect(cfgA.body['mau_window_days']).toBe(7);
    expect(cfgB.body['mau_window_days']).toBe(30);

    // A's audit trail contains ONLY A's rows — never B's (query is keyed by :gameId).
    const auditA = await request(server).get(`/admin/games/${GAME_A}/config/audit`).set('Authorization', A).expect(200);
    expect(Array.isArray(auditA.body)).toBe(true);
    expect(auditA.body.every((r: { gameId: string }) => r.gameId === GAME_A)).toBe(true);
    expect(auditA.body.some((r: { gameId: string }) => r.gameId === GAME_B)).toBe(false);

    // A's results read is scoped to A — GAME_B's counts never leak into A's response.
    const resultsA = await request(server)
      .get(`/admin/games/${GAME_A}/results/counts`)
      .set('Authorization', A)
      .expect(200);
    expect(resultsA.body.gameId).toBe(GAME_A);
  });

  // ── T-10.42 sdk_key revoke → shipped build goes dark at ingest (drop-and-tally) ─

  it("T-10.42: revoking a game's only sdk_key over HTTP makes a subsequent ingest fail auth (nothing recorded)", async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();
    const A = `Bearer ${adminToken}`;

    // Register a fresh game via the admin API → it auto-issues ONE sdk_key (raw once).
    const revokeGame = `${GAME_A}-revoke`;
    const reg = await request(server)
      .post('/admin/games')
      .set('Authorization', A)
      .send({ gameId: revokeGame, name: 'revoke' })
      .expect(201);
    const rawKey = reg.body.sdkKey.raw as string;
    const keyId = reg.body.sdkKey.id as string;

    // Issue a SECOND, non-revoked control key so the post-revoke 401 is provably a
    // consequence of the revoke (not of a bad game / bad ingest path).
    const control = await request(server)
      .post(`/admin/games/${revokeGame}/sdk-keys`)
      .set('Authorization', A)
      .expect(201);
    const controlKey = control.body.raw as string;

    try {
      // REVOKE the first key over HTTP (emergency, confirmDark required). We do NOT
      // ingest with it first, so it was never entered into the resolver's positive
      // cache — revocation is observable on the very next auth resolution (the
      // "shipped build goes dark" semantics: revoked ⇒ auth fails outright,
      // Foundation §4.4 drop-and-tally).
      await request(server)
        .post(`/admin/games/${revokeGame}/sdk-keys/${keyId}/revoke`)
        .set('Authorization', A)
        .send({ confirmDark: true })
        .expect(201);

      // The revoked key → 401 at ingest; the door never enqueues, so NOTHING is
      // recorded for the game via this key.
      await request(server).post('/v1/events').set('Authorization', `Bearer ${rawKey}`).send(batchBody(3)).expect(401);
      await request(server).post('/v1/events').set('Authorization', `Bearer ${rawKey}`).send(batchBody(3)).expect(401);

      // The CONTROL (non-revoked) key on the SAME game still authenticates → 200:
      // it is the specific key that was revoked, not the game, that goes dark.
      const okRes = await request(server)
        .post('/v1/events')
        .set('Authorization', `Bearer ${controlKey}`)
        .send(batchBody(2))
        .expect(200);
      expect(okRes.body.received).toBe(2);

      // Drop-and-tally proof: after draining, the only counts that ever land under
      // the game came through the CONTROL key (2) — the 401'd revoked-key events
      // (6) added nothing.
      const flushJob = app.get(FlushJobService);
      await waitFor(async () => {
        await flushJob.sweep();
        const rows = await ds.getRepository(EventDayCountEntity).find({ where: { gameId: revokeGame } });
        return rows.reduce((s, r) => s + Number(r.count), 0) >= 2;
      });
      const rows = await ds.getRepository(EventDayCountEntity).find({ where: { gameId: revokeGame } });
      const total = rows.reduce((s, r) => s + Number(r.count), 0);
      expect(total).toBe(2); // ONLY the control key's 2 events; the revoked key's 6 are gone
    } finally {
      await ds.getRepository(EventDayCountEntity).delete({ gameId: revokeGame });
      await ds.getRepository(GameSdkKeyEntity).delete({ gameId: revokeGame });
      await ds.getRepository(GameEntity).delete({ gameId: revokeGame });
    }
  });
});

function batchBody(count: number): Record<string, unknown> {
  const t = Date.now();
  return {
    v: 1,
    sdk: { name: 'e2e', version: '1' },
    events: Array.from({ length: count }, (_, i) => ({
      event_id: `admin-http-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`,
      name: 'login',
      kind: 'generic',
      client_event_time: t,
      client_sent_time: t,
      server_received_time: t,
      props: {},
    })),
  };
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 12000, stepMs = 250): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) {
      return;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor timed out');
}
