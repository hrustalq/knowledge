import { ForbiddenException, HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { COOKIE_TOKEN_OK_META, PUBLIC_META, QUERY_TOKEN_OK_META, UNVERIFIED_OK_META } from './access.decorator.js';
import { readCookie } from '../common/cookies.js';
import { t } from '../i18n/t.js';
import { TokenAuthService } from './token-auth.service.js';
import { bindTrace } from '@knowledge/observability';

/**
 * Phase 5 authentication (plan.md §11). AUTH_MODE=none keeps the Phase 0-4
 * dev flow: every request gets the synthetic dev principal. AUTH_MODE=api-key
 * resolves `Authorization: Bearer <token>` — `kn_` API keys against
 * users.api_key_hash, `ks_` login session tokens against sessions.token_hash
 * (SHA-256 both; plaintext credentials are never stored). Disabled users
 * (users.disabled_at) are refused on either path → 401. Authorization
 * failures are AclGuard's job → 403. Resolution itself lives in
 * TokenAuthService (shared with the live WebSocket gateway).
 */
/** The cookie the web mirrors its session token into (apps/web/src/lib/api.ts). */
const SESSION_COOKIE = 'kn_token';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenAuth: TokenAuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_META, [ctx.getHandler(), ctx.getClass()])) {
      return true;
    }
    const req = ctx.switchToHttp().getRequest();

    const header: string | undefined = req.headers['authorization'];
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
    // EventSource and <img> cannot set headers, so the routes they call opt in
    // to a URL ticket (@QueryTokenOk) or the web's session cookie
    // (@CookieTokenOk) (#102). Anywhere else both are ignored as if absent:
    // the request is unauthenticated, not quietly let in.
    const opted = (meta: string) =>
      this.reflector.getAllAndOverride<boolean>(meta, [ctx.getHandler(), ctx.getClass()]) === true;
    const queryToken =
      opted(QUERY_TOKEN_OK_META) && typeof req.query?.token === 'string' && req.query.token
        ? req.query.token
        : undefined;
    const cookieToken = opted(COOKIE_TOKEN_OK_META) ? readCookie(req.headers.cookie, SESSION_COOKIE) : null;

    // A header always wins; the others go through their narrower rules
    // (a query token is a single-use kt_ ticket, a cookie a ks_ session).
    req.principal = bearer
      ? await this.tokenAuth.resolve(bearer)
      : queryToken
        ? await this.tokenAuth.resolveTicket(queryToken)
        : cookieToken
          ? await this.tokenAuth.resolveSessionCookie(cookieToken)
          : await this.tokenAuth.resolve(undefined);
    // Every record emitted downstream carries the caller, without a single
    // service having to accept a userId argument purely to log it.
    bindTrace({ userId: req.principal.userId });

    if (
      this.tokenAuth.blocksUnverified(req.principal) &&
      !this.reflector.getAllAndOverride<boolean>(UNVERIFIED_OK_META, [ctx.getHandler(), ctx.getClass()])
    ) {
      throw new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        message: t('error.auth.emailUnverified'),
        reason: 'emailUnverified',
      });
    }
    return true;
  }
}
