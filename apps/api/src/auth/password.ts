import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;

/** scrypt parameters — stored per-hash so they can be raised later without breaking old hashes. */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

/**
 * Auth flow password hashing via node:crypto scrypt (no external deps —
 * mirrors the api-key SHA-256 decision, but memory-hard for passwords).
 * Format: `scrypt$N$r$p$<salt b64>$<hash b64>`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A hash of nothing anyone can type: what {@link burnPasswordCheck} compares against. */
const NOTHING = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEYLEN).toString('base64')}`;

/**
 * The same scrypt a real check costs, for an account that has no password to
 * check (#1092): an unknown address and an SSO-only account answer in the time
 * a wrong password takes, so timing does not say which addresses are registered.
 */
export async function burnPasswordCheck(password: string): Promise<false> {
  await verifyPassword(password, NOTHING);
  return false;
}
