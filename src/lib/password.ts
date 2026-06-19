import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing for human accounts (the agent/admin KEY path stays sha256 — those tokens are
 * high-entropy, passwords are not). scrypt is memory-hard, in the Node stdlib (zero native deps), and
 * keeps the codebase on `node:crypto`. Digest is self-describing so parameters can evolve without a
 * schema change: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`. Plaintext and digests are NEVER logged.
 */

const N = 32768; // 2^15 CPU/memory cost
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;
// scrypt needs maxmem >= 128 * N * r; the default 32 MiB is too small for N=2^15. Give generous headroom.
const MAXMEM = 128 * N * R * 2;

export function hashPassword(plaintext: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(plaintext, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(plaintext: string, digest: string): boolean {
  const parts = digest.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  if (
    nStr === undefined ||
    rStr === undefined ||
    pStr === undefined ||
    saltHex === undefined ||
    hashHex === undefined
  ) {
    return false;
  }
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
    actual = scryptSync(plaintext, Buffer.from(saltHex, 'hex'), expected.length, {
      N: n,
      r,
      p,
      maxmem: 128 * n * r * 2,
    });
  } catch {
    return false;
  }
  if (expected.length !== actual.length || expected.length === 0) return false;
  return timingSafeEqual(expected, actual);
}
