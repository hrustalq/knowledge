import type { Request } from 'express';
import { SESSION_COOKIE } from '@knowledge/contracts';
import { readCookie } from '../common/cookies.js';
import type { TokenAuthService } from './token-auth.service.js';

/**
 * Is the browser completing a connection's OAuth callback signed in as the
 * person who started the flow (#1095)?
 *
 * The callback is `@Public()` and the signed `state` proves only who *asked*.
 * Someone could send their own authorization link to a colleague, whose
 * approval would then be stored as the sender's grant. The session cookie is
 * `SameSite=Lax` on path `/`, and the API answers on the web's site (`/api`
 * behind the same origin, or `localhost` in dev), so it rides along on the
 * provider's top-level redirect back here. No session, a dead one, or someone
 * else's: the callback stores nothing. Under `AUTH_MODE=none` everyone is the
 * dev principal, which is also who the state names.
 */
export async function startedInThisBrowser(tokenAuth: TokenAuthService, req: Pick<Request, 'headers'>, userId: string): Promise<boolean> {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE) ?? '';
  try {
    return (await tokenAuth.resolveSessionCookie(token)).userId === userId;
  } catch {
    return false;
  }
}
