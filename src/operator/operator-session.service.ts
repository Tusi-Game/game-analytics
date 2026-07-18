/**
 * Operator session store (T-10.7) — Redis-backed, TTL-bounded (R8).
 *
 * Session-backend decision (flagged in tasks §4 "Session store choice"): REDIS,
 * under the reserved `ops:*` namespace (`ops:opsession:{sessionId}`), NOT a
 * signed cookie — so a logout / lockout / role change can be enforced
 * server-side immediately (a stateless cookie cannot be revoked before expiry).
 * Every key carries a TTL = `operator_session_timeout_min` (idle logout), so it
 * is safe under Redis `noeviction` (R8). The session id is a random opaque token
 * the client presents as a bearer/cookie.
 *
 * The value is a small JSON record (operatorId, role, email). Losing it just
 * logs the operator out — it is transient-and-losable (Foundation §6); no durable
 * admin state lives in Redis.
 */

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { OpsKeys } from '../common/redis-keys/redis-keys';
import type { OperatorRole } from '../database/entities/operator-account.entity';

/** The server-side session record (small; JSON-serialized in Redis). */
export interface OperatorSession {
  operatorId: string;
  email: string;
  role: OperatorRole;
}

function isOperatorSession(value: unknown): value is OperatorSession {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return typeof v.operatorId === 'string' && typeof v.email === 'string' && (v.role === 'admin' || v.role === 'viewer');
}

@Injectable()
export class OperatorSessionService {
  private readonly ttlSeconds: number;

  constructor(
    config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    const minutes = config.get<number>('OPERATOR_SESSION_TIMEOUT_MIN') ?? 120;
    this.ttlSeconds = Math.max(1, minutes) * 60;
  }

  /** Create a new session, returning its opaque id. TTL-bounded. */
  async create(session: OperatorSession): Promise<string> {
    const sessionId = randomBytes(32).toString('base64url');
    await this.redis.set(OpsKeys.operatorSession(sessionId), JSON.stringify(session), 'EX', this.ttlSeconds);
    return sessionId;
  }

  /**
   * Resolve a session id → record, sliding the idle TTL forward on a hit (idle
   * logout). Returns null on miss/expiry/corruption.
   */
  async resolve(sessionId: string): Promise<OperatorSession | null> {
    if (sessionId.length === 0) {
      return null;
    }
    const key = OpsKeys.operatorSession(sessionId);
    const raw = await this.redis.get(key);
    if (raw === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isOperatorSession(parsed)) {
      return null;
    }
    // Slide the idle timeout forward on activity.
    await this.redis.expire(key, this.ttlSeconds);
    return parsed;
  }

  /** Destroy a session (logout). Idempotent. */
  async destroy(sessionId: string): Promise<void> {
    await this.redis.del(OpsKeys.operatorSession(sessionId));
  }
}
