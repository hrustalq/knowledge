import { ForbiddenException, HttpStatus, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SESSION_COOKIE } from '@knowledge/contracts';
import { INSTALL_KEY_OK_META, MCP_KEY_OK_META, PUBLIC_META, QUERY_TOKEN_OK_META, UNVERIFIED_OK_META } from './access.decorator.js';
import { readCookie } from '../common/cookies.js';
import { requestedLocale } from '../i18n/locale.js';
import { t } from '../i18n/t.js';
import { TokenAuthService } from './token-auth.service.js';
import { cookieCsrfOk } from './session-cookie.js';
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
    // EventSource cannot set headers, so the routes it calls opt in to a URL
    // ticket (@QueryTokenOk) (#102); anywhere else a query token is ignored as
    // if absent. The browser's HttpOnly session cookie (#650) is read on every
    // route, last: a header always wins, then a ticket.
    const queryToken =
      this.reflector.getAllAndOverride<boolean>(QUERY_TOKEN_OK_META, [ctx.getHandler(), ctx.getClass()]) === true &&
      typeof req.query?.token === 'string' &&
      req.query.token
        ? req.query.token
        : undefined;
    const cookieToken = bearer || queryToken ? null : readCookie(req.headers.cookie, SESSION_COOKIE);
    if (cookieToken && !cookieCsrfOk(req)) {
      throw new ForbiddenException({ statusCode: HttpStatus.FORBIDDEN, message: t('error.auth.csrf'), reason: 'csrf' });
    }

    // Only the MCP controller admits a key limited to toolsets (#945).
    const mcp = this.reflector.getAllAndOverride<boolean>(MCP_KEY_OK_META, [ctx.getHandler(), ctx.getClass()]) === true;
    // And only the installers admit a setup key (#1371).
    const install = this.reflector.getAllAndOverride<boolean>(INSTALL_KEY_OK_META, [ctx.getHandler()]) === true;
    try {
      req.principal = bearer
        ? await this.tokenAuth.resolve(bearer, { mcp, install })
        : queryToken
          ? await this.tokenAuth.resolveTicket(queryToken)
          : cookieToken
            ? await this.tokenAuth.resolveSessionCookie(cookieToken)
            : await this.tokenAuth.resolve(undefined);
    } catch (err) {
      // RFC 9728 (#1352): a 401 from the MCP endpoint points an OAuth-capable
      // client at the resource metadata, which names this API's authorization
      // server. Claude honours the pointer only on a 401.
      const challenge = mcp && err instanceof UnauthorizedException ? this.tokenAuth.mcpChallenge() : null;
      if (challenge) ctx.switchToHttp().getResponse().setHeader('WWW-Authenticate', challenge);
      throw err;
    }
    // A request that names a language is answered in it, models included (#1185).
    // A copy: the dev principal is one shared object.
    const asked = requestedLocale(req);
    if (asked && asked !== req.principal.locale)
      req.principal = { ...req.principal, locale: asked, savedLocale: req.principal.savedLocale ?? req.principal.locale };
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
