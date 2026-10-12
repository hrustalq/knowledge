import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque single-use credentials mailed as links (`kr_` reset/invite, `kv_`
 * verify). Only the SHA-256 is stored, so a database read cannot be replayed
 * as a link — the plaintext exists in the mail and nowhere else.
 */
export function mintToken(prefix: 'kr_' | 'kv_'): { token: string; tokenHash: string } {
  const token = `${prefix}${randomBytes(32).toString('hex')}`;
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
