/**
 * Security-layer unit tests (T-00.84 / T-00.86, FR-029, ops-envelope §9).
 *
 *  - SecretCryptoService: encrypt→decrypt round-trip, ciphertext ≠ plaintext,
 *    tamper detection (GCM), disabled-without-key posture;
 *  - SubjectHashService: deterministic + per-game keyed + never plaintext;
 *  - PiiScrubService: default-deny denylist drops PII keys, value scrubber
 *    redacts email/IP/long-digit strings, non-PII passes through.
 */

import { ConfigService } from '@nestjs/config';
import { SecretCryptoService } from './secret-crypto.service';
import { SubjectHashService } from './subject-hash.service';
import { PiiScrubService } from './pii-scrub.service';

function cfg(values: Record<string, unknown>): ConfigService {
  return { get: <T>(k: string): T => values[k] as T } as unknown as ConfigService;
}

describe('SecretCryptoService (envelope-encryption, FR-029)', () => {
  const svc = new SecretCryptoService(cfg({ SECRET_MASTER_KEY: 'unit-test-master-key' }));

  it('round-trips a reversible secret', () => {
    const secret = 's3-access-key-AKIA-example';
    const ct = svc.encrypt(secret);
    expect(ct).not.toContain(secret); // a DB dump yields ciphertext, not plaintext
    expect(svc.decrypt(ct)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV) but decrypts equal', () => {
    const a = svc.encrypt('x');
    const b = svc.encrypt('x');
    expect(a).not.toBe(b);
    expect(svc.decrypt(a)).toBe('x');
    expect(svc.decrypt(b)).toBe('x');
  });

  it('detects tampering (GCM auth tag)', () => {
    const ct = svc.encrypt('secret');
    const parts = ct.split('.');
    // Flip a byte in the ciphertext segment.
    const tampered = [parts[0], parts[1], parts[2], Buffer.from('zzzz').toString('base64')].join('.');
    expect(() => svc.decrypt(tampered)).toThrow();
  });

  it('is disabled (throws on encrypt) when no master key is configured', () => {
    const dev = new SecretCryptoService(cfg({ SECRET_MASTER_KEY: '' }));
    expect(dev.enabled).toBe(false);
    expect(() => dev.encrypt('x')).toThrow();
  });
});

describe('SubjectHashService (keyed subject_ref, Q7)', () => {
  const svc = new SubjectHashService(cfg({ SECRET_MASTER_KEY: 'master' }));

  it('is deterministic for the same (game, user)', () => {
    expect(svc.subjectRef('g1', 'u1')).toBe(svc.subjectRef('g1', 'u1'));
  });

  it('is per-game keyed — same user, different games → different refs', () => {
    expect(svc.subjectRef('g1', 'u1')).not.toBe(svc.subjectRef('g2', 'u1'));
  });

  it('never returns the plaintext user_id', () => {
    const ref = svc.subjectRef('g1', 'alice@example.com');
    expect(ref).not.toContain('alice');
    expect(ref).toMatch(/^[0-9a-f]{64}$/); // hex HMAC-SHA256
  });

  it('reports keyed=true only with a real master key', () => {
    expect(svc.keyed).toBe(true);
    expect(new SubjectHashService(cfg({ SECRET_MASTER_KEY: '' })).keyed).toBe(false);
  });
});

describe('PiiScrubService (default-deny, ops-envelope §9)', () => {
  const svc = new PiiScrubService();

  it('drops default-denylisted keys entirely', () => {
    const r = svc.scrub({ email: 'a@b.com', level: 5, phone: '123' });
    expect(r.props).toEqual({ level: 5 });
    expect(r.scrubbed).toBe(true);
    expect(r.droppedKeys.sort()).toEqual(['email', 'phone']);
  });

  it('redacts PII-shaped VALUES on non-denylisted keys', () => {
    const r = svc.scrub({ note: 'contact me at a@b.com', ip_seen: '10.0.0.5', code: '1234567890123' });
    // `ip_seen` is a denylisted key shape? no — but its value is an IP → redacted;
    // actually ip_seen is not in the denylist, so value scrubbing applies.
    expect(r.props['note']).toBe('[redacted:email]');
    expect(r.props['ip_seen']).toBe('[redacted:ip]');
    expect(r.props['code']).toBe('[redacted:digits]');
    expect(r.scrubbed).toBe(true);
  });

  it('passes clean props through unchanged (scrubbed=false)', () => {
    const r = svc.scrub({ level: 5, score: 100, mode: 'hard' });
    expect(r.props).toEqual({ level: 5, score: 100, mode: 'hard' });
    expect(r.scrubbed).toBe(false);
    expect(r.droppedKeys).toHaveLength(0);
  });

  it('honors a per-game extra denylist (forward-only merge)', () => {
    const r = svc.scrub({ nickname: 'bob', level: 3 }, ['nickname']);
    expect(r.props).toEqual({ level: 3 });
    expect(r.droppedKeys).toEqual(['nickname']);
  });

  it('does not mutate the input props', () => {
    const input = { email: 'a@b.com', level: 5 };
    svc.scrub(input);
    expect(input).toEqual({ email: 'a@b.com', level: 5 });
  });
});
