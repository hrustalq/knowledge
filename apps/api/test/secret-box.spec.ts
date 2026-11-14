import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, secretSlot, secretStatus } from '../src/ai/secret-box.js';

/** #1106: an envelope is bound to its row, column and workspace, and old envelopes still read. */

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const here = secretSlot('ai_providers', 'api_key_cipher', WS_A, 'row-1');

/** The first format, written as the app did before #1106: no AAD, no key id. */
function legacy(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `gcm$${iv.toString('base64')}$${cipher.getAuthTag().toString('base64')}$${ct.toString('base64')}`;
}

describe('secret box', () => {
  it('reads an envelope back in the slot it was sealed for', () => {
    const envelope = encryptSecret('sk-1', KEY, here);
    expect(envelope).toMatch(/^gcm2\$[0-9a-f]{8}\$/);
    expect(decryptSecret(envelope, KEY, here)).toBe('sk-1');
    expect(secretStatus(envelope, KEY, here)).toBe('ok');
  });

  it('refuses an envelope moved to another row, column or workspace', () => {
    const envelope = encryptSecret('sk-1', KEY, here);
    expect(decryptSecret(envelope, KEY, { ...here, row: 'row-2' })).toBeNull();
    expect(decryptSecret(envelope, KEY, { ...here, column: 'auth_value_cipher' })).toBeNull();
    expect(decryptSecret(envelope, KEY, { ...here, table: 'ai_plugins' })).toBeNull();
    expect(decryptSecret(envelope, KEY, { ...here, workspace: WS_B })).toBeNull();
    expect(secretStatus(envelope, KEY, { ...here, workspace: WS_B })).toBe('unreadable');
  });

  it('refuses an envelope written under another key, and says so rather than reading as unset', () => {
    const envelope = encryptSecret('sk-1', OTHER_KEY, here);
    expect(decryptSecret(envelope, KEY, here)).toBeNull();
    expect(secretStatus(envelope, KEY, here)).toBe('unreadable');
    expect(secretStatus(null, KEY, here)).toBe('none');
  });

  it('still reads the first format, in any slot', () => {
    const old = legacy('sk-old', KEY);
    expect(decryptSecret(old, KEY, here)).toBe('sk-old');
    expect(decryptSecret(old, OTHER_KEY, here)).toBeNull();
  });

  it('refuses a damaged or unknown envelope without throwing', () => {
    const envelope = encryptSecret('sk-1', KEY, here);
    expect(decryptSecret(envelope.slice(0, -4) + 'AAAA', KEY, here)).toBeNull();
    expect(decryptSecret('gcm3$x$y$z', KEY, here)).toBeNull();
    expect(decryptSecret(envelope, null, here)).toBeNull();
  });
});
