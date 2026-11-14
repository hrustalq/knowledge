import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Symmetric encryption for provider credentials stored in the database
 * (ai_settings.api_key_cipher, ai_plugins.auth_value_cipher).
 *
 * node:crypto only, no external deps — same decision as auth/password.ts.
 * AES-256-GCM rather than scrypt because these are secrets we must be able to
 * READ back and send upstream, not hashes we only ever compare.
 *
 * Format (#1106): `gcm2$<key id>$<iv b64>$<tag b64>$<ciphertext b64>`, sealed
 * with additional authenticated data naming the one place the envelope may
 * live: `<table>.<column>:<workspace>:<row>` ({@link SecretSlot}). An envelope
 * copied into another row, column or workspace fails its tag check and reads
 * as unreadable. The key id is the first 8 hex of SHA-256 over the key: an
 * envelope written under another key is refused without trying it.
 *
 * The first format, `gcm$<iv>$<tag>$<ct>` (no AAD, no key id), is still read,
 * and is rewritten in the new format the next time its row saves the secret.
 *
 * Threat model, stated plainly: the key lives in SETTINGS_ENCRYPTION_KEY on the
 * same host as the API. This protects a database dump or a replica; it does not
 * protect against a compromised API process.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32;

/**
 * Where an envelope lives. `workspace` is the owning workspace, or null for a
 * row that has none (a person's credential, platform settings); `row` is the
 * row's primary key (or, for a value that never lands in a row, the id of the
 * thing that carries it, such as an OAuth state's nonce).
 */
export interface SecretSlot {
  table: string;
  column: string;
  workspace: string | null;
  row: string;
}

export const secretSlot = (table: string, column: string, workspace: string | null, row: string): SecretSlot => ({ table, column, workspace, row });

const aadOf = (slot: SecretSlot) => Buffer.from(`${slot.table}.${slot.column}:${slot.workspace ?? '-'}:${slot.row}`, 'utf8');

/** First 8 hex of SHA-256 over the key: names the key without revealing it. */
export const keyIdOf = (key: Buffer): string => createHash('sha256').update(key).digest('hex').slice(0, 8);

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

export function encryptSecret(plaintext: string, key: Buffer | null, slot: SecretSlot): string {
  if (!key) throw new MissingEncryptionKeyError();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(aadOf(slot));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `gcm2$${keyIdOf(key)}$${iv.toString('base64')}$${cipher.getAuthTag().toString('base64')}$${ct.toString('base64')}`;
}

/**
 * Whether an envelope reads in this slot under this key: `none` when there is
 * no envelope, `unreadable` when there is one that does not decrypt (another
 * key, another row, damage). A caller that would otherwise fall back to an env
 * credential shows `unreadable` instead of quietly switching (#1106).
 */
export function secretStatus(envelope: string | null | undefined, key: Buffer | null, slot: SecretSlot): 'none' | 'ok' | 'unreadable' {
  if (!envelope) return 'none';
  return decryptSecret(envelope, key, slot) === null ? 'unreadable' : 'ok';
}

/**
 * Returns null for anything that will not decrypt — an unset key, a row
 * written under a rotated key, an envelope moved from another row, a corrupted
 * envelope. A caller that falls back to something else on null must say so
 * ({@link secretStatus}).
 */
export function decryptSecret(envelope: string | null | undefined, key: Buffer | null, slot: SecretSlot): string | null {
  if (!envelope || !key) return null;
  const parts = envelope.split('$');
  let iv: string, tag: string, ct: string, aad: Buffer | null;
  if (parts.length === 5 && parts[0] === 'gcm2') {
    if (parts[1] !== keyIdOf(key)) return null;
    [, , iv, tag, ct] = parts as [string, string, string, string, string];
    aad = aadOf(slot);
  } else if (parts.length === 4 && parts[0] === 'gcm') {
    // The first format: no AAD, no key id. Read until the row saves again.
    [, iv, tag, ct] = parts as [string, string, string, string];
    aad = null;
  } else return null;
  try {
    const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'));
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Last-4 hint for the UI, so an admin can tell which key is stored without revealing it. */
export function maskSecret(plaintext: string): string {
  const tail = plaintext.slice(-4);
  return tail.length === 4 ? `••••••••${tail}` : '••••••••';
}
