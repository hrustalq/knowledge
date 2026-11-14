import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { readCookie } from '../common/cookies.js';
import { SESSION_COOKIE } from '@knowledge/contracts';

/**
 * The browser's session lives only in an HttpOnly cookie (#650): no script on
 * the origin can read it, so an XSS cannot carry it off. A sign-in route takes
 * the token out of its service's answer and sets it here; the JSON body the
 * browser sees never holds it.
 */
export type Issued<T> = T & { token: string };

/**
 * `Secure` follows the configured web origin rather than the request, which
 * reaches the API over plain HTTP behind the proxies. `http://localhost` in
 * dev stays usable in every browser; an `https://` deployment always gets it.
 */
const cookieOptions = (webBaseUrl: string) =>
  ({ httpOnly: true, secure: webBaseUrl.startsWith('https:'), sameSite: 'lax', path: '/' }) as const;

/** Sets the session cookie to expire with the session, and answers the body without the token. */
export function setSessionCookie<T extends { expiresAt: string }>(
  res: Response,
  issued: Issued<T>,
  webBaseUrl: string,
): T {
  const { token, ...body } = issued;
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(webBaseUrl), expires: new Date(body.expiresAt) });
  return body as unknown as T;
}

export function clearSessionCookie(res: Response, webBaseUrl: string): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions(webBaseUrl));
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF for a request the cookie authenticates. A cookie rides along on any
 * request the browser makes, so an unsafe method must also carry a header a
 * cross-site form cannot send and a cross-site script cannot add without a
 * CORS preflight, which the API never answers (it enables no CORS). The web
 * sends `X-Requested-With` on every call; presence is the proof, the value is
 * not checked. A bearer header or a `kt_` ticket is not ambient and needs no
 * such proof.
 */
export function cookieCsrfOk(req: Pick<Request, 'method' | 'headers'>): boolean {
  return SAFE_METHODS.has(req.method.toUpperCase()) || typeof req.headers['x-requested-with'] === 'string';
}

/**
 * The SSO flow cookie (#1095): a random value set on the browser that starts a
 * sign-in, whose hash the login transaction keeps. The exchange requires it,
 * so the 60 s fragment code finishes a sign-in only in the browser that began
 * it — a forwarded `/auth/sso/complete#code=…` signs nobody in. `SameSite=Lax`
 * and path `/`, so the web's same-site POST to the exchange carries it.
 */
export const SSO_FLOW_COOKIE = 'kn_sso';

/** Mint the flow cookie, set it for `ttlSec`, and answer its value for the service to hash. */
export function setSsoFlowCookie(res: Response, webBaseUrl: string, ttlSec: number): string {
  const value = randomBytes(32).toString('base64url');
  res.cookie(SSO_FLOW_COOKIE, value, { ...cookieOptions(webBaseUrl), maxAge: ttlSec * 1000 });
  return value;
}

export function readSsoFlowCookie(req: Pick<Request, 'headers'>): string | undefined {
  return readCookie(req.headers.cookie, SSO_FLOW_COOKIE) ?? undefined;
}

export function clearSsoFlowCookie(res: Response, webBaseUrl: string): void {
  res.clearCookie(SSO_FLOW_COOKIE, cookieOptions(webBaseUrl));
}
