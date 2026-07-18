import { PasswordService } from './password.service';

/**
 * Operator password hashing (argon2id). Proves round-trip verify, rejects a wrong
 * password, and never stores the plaintext (the hash differs from the input and
 * carries the argon2id marker).
 */
describe('PasswordService (argon2id)', () => {
  const svc = new PasswordService();

  it('verifies the correct password and rejects a wrong one', async () => {
    const hash = await svc.hash('correct horse battery staple');
    expect(await svc.verify(hash, 'correct horse battery staple')).toBe(true);
    expect(await svc.verify(hash, 'wrong password')).toBe(false);
  });

  it('produces an argon2id PHC string (never the plaintext)', async () => {
    const hash = await svc.hash('secret');
    expect(hash).not.toBe('secret');
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('verify returns false on a malformed hash rather than throwing', async () => {
    expect(await svc.verify('not-a-hash', 'x')).toBe(false);
  });
});
