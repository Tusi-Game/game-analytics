import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
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
import { IngestKeys } from '../src/common/redis-keys/redis-keys';
import { configurePanel } from '../src/panel/panel-bootstrap';

/**
 * Panel (012) SSR e2e over HTTP against a LIVE AppModule + Postgres + Redis
 * (T-11.85 game isolation · T-11.86 live-vs-flushed provisional · T-11.87 classic
 * Day-N label · T-11.88 role enforcement · T-11.89 single-deploy / static assets
 * served in one process · T-11.90 FR-025 all-four-surfaces render). The auth flow
 * is the real cookie transport: POST /panel/login → HttpOnly panel_session cookie
 * → guarded pages resolve it via the SAME OperatorSessionService.
 *
 * Requires the stack; SKIPS if unreachable (reuses the admin-http e2e reachable()
 * pattern) so a stackless CI run stays green. `docker compose up -d postgres redis`.
 */

const SUFFIX = Math.random().toString(36).slice(2, 8);
const ADMIN_EMAIL = `panel-admin-${SUFFIX}@studio.test`;
const VIEWER_EMAIL = `panel-viewer-${SUFFIX}@studio.test`;
const PASSWORD = 'correct horse battery staple';
const GAME_A = `panel-e2e-a-${SUFFIX}`;
const GAME_B = `panel-e2e-b-${SUFFIX}`;

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

/** Extract the panel_session cookie value from a Set-Cookie header list. */
function cookieFrom(res: request.Response): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const c of list) {
    const m = /panel_session=([^;]+)/.exec(c);
    if (m) {
      return `panel_session=${m[1]}`;
    }
  }
  return '';
}

describe('Panel (012) SSR e2e over HTTP (live stack)', () => {
  let app: INestApplication | null = null;
  let ds: DataSource;
  let redis: Redis;
  let up = false;
  let adminCookie = '';
  let viewerCookie = '';
  let rawDir = '';
  const today = new Date().toISOString().slice(0, 10);

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
    process.env.NODE_ENV = 'test';
    process.env.SECRET_MASTER_KEY ??= 'panel-e2e-master';
    process.env.INGEST_WORKER_ENABLED = '0';
    rawDir = mkdtempSync(join(tmpdir(), 'panel-e2e-raw-'));
    process.env.RAW_FILE_DIR = rawDir;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nestApp = moduleRef.createNestApplication<NestExpressApplication>();
    // Wire the panel view engine + static exactly as production bootstrap does.
    configurePanel(nestApp);
    app = nestApp;
    await app.init();
    ds = app.get(DataSource);
    redis = app.get<Redis>('REDIS_CLIENT');

    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    const accounts = ds.getRepository(OperatorAccountEntity);
    for (const [email, role] of [
      [ADMIN_EMAIL, 'admin'],
      [VIEWER_EMAIL, 'viewer'],
    ] as const) {
      await accounts.save(
        accounts.create({
          email,
          passwordHash,
          mfaTotpSecret: null,
          failedLoginCount: 0,
          lockedUntil: null,
          role,
          createdAt: new Date(),
          disabledAt: null,
        }),
      );
    }

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

    // Seed durable + live event counts so the read-model merge is observable:
    //  - GAME_A: durable sealed count (Postgres) + a HIGHER live count (Redis today).
    //  - GAME_B: a distinct durable count (for the isolation test).
    await ds
      .getRepository(EventDayCountEntity)
      .insert({ gameId: GAME_A, utcDay: today, eventName: 'game_a_event', count: '100' });
    await ds
      .getRepository(EventDayCountEntity)
      .insert({ gameId: GAME_B, utcDay: today, eventName: 'game_b_event', count: '55' });
    // Live Redis open-day count for GAME_A exceeds the durable floor → provisional.
    await redis.hset(IngestKeys.cnt(GAME_A, today), 'game_a_event', '175');

    adminCookie = cookieFrom(
      await request(app.getHttpServer()).post('/panel/login').send({ email: ADMIN_EMAIL, password: PASSWORD }),
    );
    viewerCookie = cookieFrom(
      await request(app.getHttpServer()).post('/panel/login').send({ email: VIEWER_EMAIL, password: PASSWORD }),
    );
  });

  afterAll(async () => {
    delete process.env.INGEST_WORKER_ENABLED;
    delete process.env.RAW_FILE_DIR;
    if (up && ds) {
      await redis.del(IngestKeys.cnt(GAME_A, today));
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

  it('login issues an HttpOnly panel_session cookie; unauthenticated guarded routes redirect to /panel/login', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();
    expect(adminCookie).toMatch(/panel_session=/);

    // The login Set-Cookie is HttpOnly + SameSite=Lax.
    const loginRes = await request(server).post('/panel/login').send({ email: ADMIN_EMAIL, password: PASSWORD });
    const setCookie = ([] as string[]).concat(loginRes.headers['set-cookie'] ?? []).join(';');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    // Unauthenticated guarded route → 302 redirect to login.
    const redir = await request(server).get('/panel/games');
    expect(redir.status).toBe(302);
    expect(redir.headers.location).toBe('/panel/login');
  });

  // ── T-11.85 game isolation (FR-002 / SC-003) ──────────────────────────────────
  it('T-11.85: no game-scoped view crosses game boundaries', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();

    const a = await request(server).get(`/panel/${GAME_A}`).set('Cookie', adminCookie).expect(200);
    const b = await request(server).get(`/panel/${GAME_B}`).set('Cookie', adminCookie).expect(200);

    // GAME_A's dashboard shows only GAME_A's identity, never GAME_B's overview.
    expect(a.text).toContain(`${GAME_A} — Overview`);
    expect(a.text).not.toContain(`${GAME_B} — Overview`);
    expect(b.text).toContain(`${GAME_B} — Overview`);

    // GAME_A's top-events surface carries GAME_A's event, not GAME_B's.
    expect(a.text).toContain('game_a_event');
    expect(a.text).not.toContain('game_b_event');

    // A nonexistent game 404s (GameAccessGuard).
    await request(server).get(`/panel/no-such-game-${SUFFIX}`).set('Cookie', adminCookie).expect(404);
  });

  // ── T-11.86 live-vs-flushed (FR-026 / Foundation §3.3) ────────────────────────
  it('T-11.86: current-day figures merge live Redis over sealed Postgres (GREATEST) + provisional badge', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();
    const res = await request(server).get(`/panel/${GAME_A}`).set('Cookie', adminCookie).expect(200);
    // Live (175) > durable floor (100) → GREATEST merge surfaces 175, not summed 275.
    expect(res.text).toContain('175');
    expect(res.text).not.toContain('275');
    // A period including today renders the provisional badge.
    expect(res.text.toLowerCase()).toContain('provisional');
  });

  // ── T-11.87 classic Day-N retention label (FR-017) ────────────────────────────
  it('T-11.87: retention view carries the explicit "Classic Day-N Retention" label', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();
    const res = await request(server).get(`/panel/${GAME_A}/retention`).set('Cookie', adminCookie).expect(200);
    expect(res.text).toContain('Classic Day-N Retention');
    // Immature cells never render a misleading number — the N/A convention is present.
    expect(res.text).toContain('N/A');
  });

  // ── T-11.88 role enforcement (spec §3.3) ──────────────────────────────────────
  it('T-11.88: viewer is 403 on config-write / credential / operator / erasure; admin is allowed', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();

    // Viewer: read is allowed, every write is 403.
    await request(server).get(`/panel/${GAME_A}/config`).set('Cookie', viewerCookie).expect(200);
    await request(server)
      .put(`/panel/${GAME_A}/config/top_n_events`)
      .set('Cookie', viewerCookie)
      .send({ value: '15' })
      .expect(403);
    await request(server).post(`/panel/${GAME_A}/sdk-keys`).set('Cookie', viewerCookie).expect(403);
    await request(server)
      .post(`/panel/${GAME_A}/ops/erasure`)
      .set('Cookie', viewerCookie)
      .send({ userId: 'u1', attestation: 'verified' })
      .expect(403);
    await request(server).get('/panel/operators').set('Cookie', viewerCookie).expect(403);

    // Admin: config write succeeds (200), operators list is visible.
    await request(server)
      .put(`/panel/${GAME_A}/config/top_n_events`)
      .set('Cookie', adminCookie)
      .send({ value: '15' })
      .expect(200);
    await request(server).get('/panel/operators').set('Cookie', adminCookie).expect(200);
  });

  // ── T-11.89 single-deploy: panel + Tailwind + vendored JS served in one process (SC-009) ─
  it('T-11.89: the same NestJS process serves the compiled Tailwind CSS + vendored JS (no CDN)', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();
    const css = await request(server).get('/styles/tailwind.css').expect(200);
    expect(css.headers['content-type']).toMatch(/css/);
    expect(css.text.length).toBeGreaterThan(1000);
    await request(server).get('/scripts/htmx.min.js').expect(200);
    await request(server).get('/scripts/alpine.min.js').expect(200);
    await request(server).get('/scripts/chart.min.js').expect(200);
    await request(server).get('/scripts/panel.js').expect(200);
    // The login page references the self-hosted assets, never a CDN host.
    const login = await request(server).get('/panel/login').expect(200);
    expect(login.text).toContain('/styles/tailwind.css');
    expect(login.text).toContain('/scripts/htmx.min.js');
    expect(login.text).not.toMatch(/https?:\/\/(cdn|unpkg|jsdelivr)/i);
  });

  // ── T-11.90 FR-025 coverage: all four metric surfaces render per game ──────────
  it('T-11.90: per game the panel presents events, economy, retention, and segmented monetization', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();
    // Live events (overview) already asserted; the four metric views all render.
    await request(server).get(`/panel/${GAME_A}`).set('Cookie', adminCookie).expect(200); // events overview
    await request(server).get(`/panel/${GAME_A}/economy`).set('Cookie', adminCookie).expect(200);
    await request(server).get(`/panel/${GAME_A}/retention`).set('Cookie', adminCookie).expect(200);
    await request(server).get(`/panel/${GAME_A}/monetization`).set('Cookie', adminCookie).expect(200);
    await request(server).get(`/panel/${GAME_A}/sessions`).set('Cookie', adminCookie).expect(200);
  });

  // ── Extra: exceptions gated on drop_counter_visible (R12) ──────────────────────
  it('exceptions view is gated on drop_counter_visible', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();
    // Default drop_counter_visible = true → the pivot renders.
    const on = await request(server).get(`/panel/${GAME_A}/ops/exceptions`).set('Cookie', adminCookie).expect(200);
    expect(on.text).not.toContain('The exception counter is hidden');

    // Turn it off (admin config write), then the view shows the hidden message.
    await request(server)
      .put(`/panel/${GAME_A}/config/drop_counter_visible`)
      .set('Cookie', adminCookie)
      .send({ value: 'false' })
      .expect(200);
    // The config-read cache TTL may lag; poll briefly for the effective value.
    let hidden = false;
    for (let i = 0; i < 40 && !hidden; i += 1) {
      const off = await request(server).get(`/panel/${GAME_A}/ops/exceptions`).set('Cookie', adminCookie);
      hidden = off.text.includes('The exception counter is hidden');
      if (!hidden) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    expect(hidden).toBe(true);
  });

  // ── Extra: credential show-once (R8 / P13) ────────────────────────────────────
  it('a freshly issued credential is shown exactly once (show-once flag consumed on view)', async () => {
    if (!up || !app) return;
    const server = app.getHttpServer();
    // Admin issues an sdk_key → 302 to the credential-show page.
    const issue = await request(server).post(`/panel/${GAME_A}/sdk-keys`).set('Cookie', adminCookie);
    expect(issue.status).toBe(302);
    const showUrl = issue.headers.location as string;
    expect(showUrl).toContain('/credential/');

    // First view renders the raw value once.
    const first = await request(server).get(showUrl).set('Cookie', adminCookie).expect(200);
    expect(first.text).toContain('shown only once');

    // Second view: the flag is consumed → redirect away with a "no longer available" flash.
    const second = await request(server).get(showUrl).set('Cookie', adminCookie);
    expect(second.status).toBe(302);
    expect(second.headers.location).toContain('no+longer+available');
  });
});
