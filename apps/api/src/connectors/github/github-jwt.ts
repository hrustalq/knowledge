import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

/**
 * The two pieces of signing the GitHub App needs, as pure functions
 * (docs/features/28).
 *
 * Kept out of the service so they can be tested without Nest and without a
 * network — which is the only way the `state` round trip below is worth
 * anything, since the callback that verifies it is `@Public()`.
 *
 * No JWT dependency. An App JWT is RS256 over two base64url segments, which
 * `node:crypto` signs in three lines; pulling in a library to do that would buy
 * nothing and is against the house rule that adapters talk plain `fetch` with
 * no per-vendor SDK.
 */

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Normalises whatever shape the private key arrived in.
 *
 * GitHub hands out a multi-line PKCS#1 PEM. A `.env` file cannot hold newlines,
 * so in practice this arrives one of three ways and all three must work:
 * base64 of the whole PEM (what a secrets manager wants), a single line with
 * literal `\n` escapes (what people paste into a .env), or a real PEM (a file
 * mount, or Docker secrets).
 */
export function parsePrivateKey(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.includes('-----BEGIN')) return value.replace(/\\n/g, '\n');
  // Not a PEM, so it should be base64 of one. Reject anything that decodes to
  // something else rather than handing openssl a garbage buffer later.
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  return decoded.includes('-----BEGIN') ? decoded : null;
}

/**
 * A JWT that authenticates as the App itself, for minting installation tokens.
 *
 * `iat` is backdated a minute because GitHub rejects a token issued in its
 * future and clock skew between us and them is real. `exp` is nine minutes;
 * GitHub's own ceiling is ten, and sitting exactly on a limit is how you
 * discover it is exclusive.
 */
export function appJwt(appId: string, privateKeyPem: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).end().sign(privateKeyPem);
  return `${header}.${payload}.${b64url(signature)}`;
}

/** What the OAuth/install round trip has to carry across a redirect we do not control. */
export interface OauthState {
  workspaceId: string;
  userId: string;
  /** Where in the web app to land afterwards, so the wizard resumes where it left off. */
  returnTo: string;
  nonce: string;
  /** Unix seconds. */
  exp: number;
}

/**
 * Signs the `state` parameter.
 *
 * This is the only thing standing between the `@Public()` callback and a forged
 * installation: without it, anyone who can reach the callback could bind an
 * arbitrary installation id to an arbitrary workspace. The signature covers the
 * workspace, the user and an expiry, so a captured state is neither replayable
 * into a different workspace nor usable tomorrow.
 */
export function signState(state: OauthState, key: Buffer): string {
  const body = b64url(JSON.stringify(state));
  const mac = b64url(createHmac('sha256', key).update(body).digest());
  return `${body}.${mac}`;
}

/** Null for anything that does not verify — wrong signature, malformed, or expired. */
export function verifyState(raw: string, key: Buffer, now = Date.now()): OauthState | null {
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts;

  const expected = Buffer.from(b64url(createHmac('sha256', key).update(body).digest()));
  const actual = Buffer.from(mac);
  // Length must match before timingSafeEqual, which throws on a mismatch rather
  // than returning false.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OauthState;
    if (typeof parsed.exp !== 'number' || parsed.exp * 1000 < now) return null;
    if (!parsed.workspaceId || !parsed.userId) return null;
    return parsed;
  } catch {
    return null;
  }
}
