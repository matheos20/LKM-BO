import crypto from 'node:crypto';

// Format : scrypt$N$r$p$<sel base64>$<hash base64>
const N = 2 ** 15;
const R = 8;
const P = 1;
const LEN = 64;
const MAXMEM = 128 * N * R * 2;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, LEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password, stored) {
  const [algo, n, r, p, salt, hash] = String(stored).split('$');
  if (algo !== 'scrypt' || typeof password !== 'string' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const opts = { N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2 };
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, opts);
  return crypto.timingSafeEqual(actual, expected);
}

/** Comparaison à temps constant de deux chaînes. */
export function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
