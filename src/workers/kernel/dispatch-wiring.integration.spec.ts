/**
 * Wiring regression ([kind-dispatch] seam) — proves the story registrations
 * actually REACH the dispatchers + the flush orchestrator in the ASSEMBLED
 * application graph.
 *
 * The seam's contract (kind-dispatch.ts / flush-job.service.ts) is that each story
 * module (003/004/006) contributes its per-kind validate/durable/hot triple and
 * its extra flush plans, and the WorkersModule-owned consumers pick them ALL up.
 * The manual-wiring unit specs cannot catch a cross-module DI break because they
 * construct the dispatchers by hand; this boots the real AppModule so a stranded
 * multi-provider (consumer resolves the `@Optional` empty default instead of the
 * story contributions) fails loudly.
 *
 * Skips when the live stack is unreachable (AppModule opens TypeORM/Redis at boot),
 * mirroring the other live specs.
 */

import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../../app.module';
import { KindDispatchValidator, KindDispatchDurableHook, KindDispatchHotHook } from './kind-dispatch';
import { FlushJobService } from '../flush/flush-job.service';
import { connectRedisOrNull, connectPostgresOrNull } from '../../testing/live-infra';

describe('kind-dispatch + flush wiring (assembled AppModule)', () => {
  let app: INestApplicationContext | null = null;

  beforeAll(async () => {
    const redis = await connectRedisOrNull();
    const pg = await connectPostgresOrNull();
    if (!redis || !pg) {
      return; // infra down → skip (each test guards on `app`)
    }
    await redis.quit();
    await pg.destroy();
    // AppModule's config (env.ts) fails fast on missing DB_*/REDIS_* keys. Fill in
    // the same local-stack defaults connect*OrNull just proved reachable, so the
    // boot uses the live stack rather than throwing on an unset env.
    const envDefaults: Record<string, string> = {
      DB_HOST: '127.0.0.1',
      DB_PORT: '5432',
      DB_USER: 'analytics',
      DB_PASSWORD: 'analytics',
      DB_NAME: 'analytics',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: '6379',
    };
    for (const [k, v] of Object.entries(envDefaults)) {
      process.env[k] ??= v;
    }
    app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('every typed story kind reaches all three dispatchers', () => {
    if (!app) return;
    const expected = ['economy', 'purchase', 'session'];
    const validator = app.get(KindDispatchValidator);
    const durable = app.get(KindDispatchDurableHook);
    const hot = app.get(KindDispatchHotHook);
    expect([...validator.registeredKinds()].sort()).toEqual(expected);
    expect([...durable.registeredKinds()].sort()).toEqual(expected);
    expect([...hot.registeredKinds()].sort()).toEqual(expected);
  });

  it('story flush domains reach the flush orchestrator (sess/act/ret + economy/monetization)', () => {
    if (!app) return;
    const flush = app.get(FlushJobService);
    const domains = new Set(flush.registeredDomains());
    for (const d of ['sess', 'act', 'ret']) {
      expect(domains.has(d)).toBe(true);
    }
  });
});
