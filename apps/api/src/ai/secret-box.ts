import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Symmetric encryption for provider credentials stored in the database
 * (ai_settings.api_key_cipher, ai_plugins.auth_value_cipher).
 *
 * node:crypto only, no external deps — same decision as auth/password.ts.
 * AES-256-GCM rather than scrypt because these are secrets we must be able to
 * READ back and send upstream, not hashes we only ever compare.
 *
 * Format: `gcm$<iv b64>$<tag b64>$<ciphertext b64>`, versioned by that prefix
 * so the algorithm can change later without breaking stored rows.
 *
 * Threat model, stated plainly: the key lives in SETTINGS_ENCRYPTION_KEY on the
 * same host as the API. This protects a database dump or a replica; it does not
 * protect against a compromised API process.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32;

export class MissingEncryptionKeyError extends Error {
  constructor() {
    super('SETTINGS_ENCRYPTION_KEY is not set — provider credentials cannot be stored');
    this.name = 'MissingEncryptionKeyError';
  }
}

/** Parses the configured key. Returns null when unset, throws when set but malformed. */
export function parseKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `SETTINGS_ENCRYPTION_KEY must be ${KEY_BYTES} base64-encoded bytes (got ${key.length}). Generate: openssl rand -base64 32`,
    );
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer | null): string {
  if (!key) throw new MissingEncryptionKeyError();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `gcm$${iv.toString('base64')}$${cipher.getAuthTag().toString('base64')}$${ct.toString('base64')}`;
}

/**
 * Returns null for anything that will not decrypt — an unset key, a row
 * written under a rotated key, a corrupted envelope. Callers treat that as
 * "no credential configured" and fall back to the env value, which keeps a
 * key rotation from taking the whole assistant down.
 */
export function decryptSecret(envelope: string | null | undefined, key: Buffer | null): string | null {
  if (!envelope || !key) return null;
  const parts = envelope.split('$');
  if (parts.length !== 4 || parts[0] !== 'gcm') return null;
  const [, ivB64, tagB64, ctB64] = parts;
  try {
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Last-4 hint for the UI, so an admin can tell which key is stored without revealing it. */
export function maskSecret(plaintext: string): string {
  const tail = plaintext.slice(-4);
  return tail.length === 4 ? `••••••••${tail}` : '••••••••';
}
