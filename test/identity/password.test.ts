import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/lib/password.js';

describe('password KDF (scrypt)', () => {
  it('produces a self-describing scrypt$ digest and round-trips', () => {
    const digest = hashPassword('correct horse battery staple');
    expect(digest.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct horse battery staple', digest)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const digest = hashPassword('s3cret-pw');
    expect(verifyPassword('not-the-pw', digest)).toBe(false);
  });

  it('uses a random salt — same password yields different digests', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('returns false (never throws) on a malformed digest', () => {
    expect(verifyPassword('x', 'not-a-valid-digest')).toBe(false);
    expect(verifyPassword('x', 'scrypt$bad')).toBe(false);
  });
});
