import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, createVerify, randomBytes } from 'node:crypto';
import { appJwt, parsePrivateKey, signState, verifyState, type OauthState } from '../src/connectors/github/github-jwt.js';

/**
 * The signing half of the GitHub App integration (docs/features/28).
 *
 * `verifyState` is the only thing standing between the `@Public()` OAuth
 * callback and a forged installation — without it anyone who could reach that
 * URL could bind an installation of their choosing to a workspace of their
 * choosing. So the tampering cases below are the point of this file, not
 * decoration around the happy path.
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('parsePrivateKey', () => {
  it('takes a real PEM unchanged', () => {
    expect(parsePrivateKey(pem)).toContain('-----BEGIN');
  });

  it('takes base64 of a PEM, which is how a secrets manager stores one', () => {
    expect(parsePrivateKey(Buffer.from(pem).toString('base64'))).toContain('-----BEGIN');
  });

  it('takes a single line with literal \\n escapes, which is what fits in a .env', () => {
    const escaped = pem.replace(/\n/g, '\\n');
    const parsed = parsePrivateKey(escaped);
    expect(parsed).toContain('-----BEGIN');
    // The escapes must actually become newlines, or openssl rejects the key.
    expect(parsed).toContain('\n');
    expect(parsed).not.toContain('\\n');
  });

  it('answers null for empty and for garbage rather than handing openssl a bad buffer', () => {
    expect(parsePrivateKey('')).toBeNull();
    expect(parsePrivateKey('   ')).toBeNull();
    expect(parsePrivateKey('bm90LWEta2V5')).toBeNull(); // base64 of "not-a-key"
  });
});

describe('appJwt', () => {
  const now = 1_700_000_000_000;

  it('signs a verifiable RS256 token', () => {
    const token = appJwt('12345', pem, now);
    const [header, payload, signature] = token.split('.');

    expect(decodeSegment(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(
      createVerify('RSA-SHA256')
        .update(`${header}.${payload}`)
        .end()
        .verify(publicKey, Buffer.from(signature, 'base64url')),
    ).toBe(true);
  });

  it('backdates iat and stays inside GitHub ten-minute ceiling', () => {
    const claims = decodeSegment(appJwt('12345', pem, now).split('.')[1]);
    const seconds = Math.floor(now / 1000);

    expect(claims.iss).toBe('12345');
    // Backdated, because GitHub rejects a token issued in its own future and
    // clock skew between us and them is real.
    expect(claims.iat).toBe(seconds - 60);
    expect(claims.exp).toBe(seconds + 480);
    // GitHub caps exp - iat at ten minutes, and the backdated minute counts
    // toward that span. Strictly inside, not exactly on it.
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThan(600);
  });
});

describe('signState / verifyState', () => {
  const key = randomBytes(32);
  const base: OauthState = {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    returnTo: '/settings/connectors',
    nonce: 'abc',
    exp: Math.floor(Date.now() / 1000) + 600,
  };

  it('round-trips a state it signed', () => {
    expect(verifyState(signState(base, key), key)).toEqual(base);
  });

  it('refuses a state signed with a different key', () => {
    expect(verifyState(signState(base, key), randomBytes(32))).toBeNull();
  });

  it('refuses a tampered workspace id — the attack this exists to stop', () => {
    const signed = signState(base, key);
    const [body] = signed.split('.');
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OauthState;
    forged.workspaceId = '33333333-3333-4333-8333-333333333333';

    const swapped = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signed.split('.')[1]}`;
    expect(verifyState(swapped, key)).toBeNull();
  });

  it('refuses an expired state, so a captured redirect is not usable later', () => {
    const stale = { ...base, exp: Math.floor(Date.now() / 1000) - 1 };
    expect(verifyState(signState(stale, key), key)).toBeNull();
  });

  it('refuses malformed input without throwing', () => {
    for (const bad of ['', 'nodot', 'a.b.c', '...', 'Zm9v.YmFy']) {
      expect(verifyState(bad, key)).toBeNull();
    }
  });

  it('refuses a state missing the fields the callback relies on', () => {
    const hollow = { ...base, workspaceId: '' };
    expect(verifyState(signState(hollow, key), key)).toBeNull();
  });
});
