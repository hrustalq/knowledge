import { createHash, randomBytes } from 'node:crypto';

/**
 * An opaque credential whose plaintext is handed out once: `kr_` reset/invite
 * and `kv_` verify links, `ks_` sessions, `kn_` API keys, `kt_` URL tickets,
 * `kscim_` SCIM tokens. Only the SHA-256 is stored, so a database read cannot
 * be replayed as a credential. `bytes` keeps each kind's existing length.
 */
export function mintToken(prefix: string, bytes = 32): { token: string; tokenHash: string } {
  const token = `${prefix}${randomBytes(bytes).toString('hex')}`;
  return { token, tokenHash: hashToken(token) };
}

/** The SHA-256 a credential is stored and looked up by. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
