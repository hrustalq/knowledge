import { UnauthorizedException } from '@nestjs/common';
import type { AccessService } from '../auth/access.service.js';
import type { TokenAuthService } from '../auth/token-auth.service.js';
import type { Principal } from '../auth/principal.js';

/**
 * How often an open live stream (WS or SSE) is re-judged (#1097). A stream is
 * authorized once, when it opens; this is how long a logout, a revoked key, a
 * disabled account or a removal from the workspace can take to end it.
 */
export const LIVE_RECHECK_MS = 30_000;

/** `unknown`: the check itself failed (a PG blip), so nobody can say the reader still stands. */
type Standing = 'ok' | 'unauthorized' | 'forbidden' | 'unknown';

/**
 * Does the credential that opened a stream still stand (account, key,
 * session, platform-admin flag)? A failed read is `unknown`, and the caller
 * ends the stream (#1143): the reconnect authenticates anew, so a credential
 * revoked during an outage cannot outlive it.
 */
export async function credentialStanding(tokenAuth: Pick<TokenAuthService, 'isCurrent'>, principal: Principal): Promise<Standing> {
  try {
    return (await tokenAuth.isCurrent(principal)) ? 'ok' : 'unauthorized';
  } catch {
    return 'unknown';
  }
}

/** May it still read this workspace — the `requireRole` the subscription passed, asked again. */
export async function workspaceStands(access: Pick<AccessService, 'requireRole'>, principal: Principal, workspaceId: string): Promise<Standing> {
  try {
    await access.requireRole(principal, workspaceId, 'viewer');
    return 'ok';
  } catch (e) {
    if (e instanceof UnauthorizedException) return 'unauthorized';
    const status = (e as { getStatus?: () => number }).getStatus?.();
    return status === 403 || status === 404 ? 'forbidden' : 'unknown';
  }
}

/** Both, for a stream bound to one workspace (SSE): anything but `ok` ends it. */
export async function liveStanding(
  tokenAuth: Pick<TokenAuthService, 'isCurrent'>,
  access: Pick<AccessService, 'requireRole'>,
  principal: Principal,
  workspaceId: string,
): Promise<Standing> {
  const credential = await credentialStanding(tokenAuth, principal);
  return credential === 'ok' ? workspaceStands(access, principal, workspaceId) : credential;
}
