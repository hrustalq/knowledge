import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PUBLIC_META, QUERY_TOKEN_OK_META } from './access.decorator.js';
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
    // to ?token= with @QueryTokenOk (#102). Anywhere else the query token is
    // ignored as if absent: the request is unauthenticated, not quietly let in.
    const queryTokenOk = this.reflector.getAllAndOverride<boolean>(QUERY_TOKEN_OK_META, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const queryToken =
      queryTokenOk && typeof req.query?.token === 'string' && req.query.token ? req.query.token : undefined;

    // A header always wins; a query token goes through the narrower URL rules
    // (single-use kt_ tickets, ks_ sessions; never a long-lived kn_ key).
    req.principal =
      !bearer && queryToken
        ? await this.tokenAuth.resolveQueryToken(queryToken)
        : await this.tokenAuth.resolve(bearer);
    // Every record emitted downstream carries the caller, without a single
    // service having to accept a userId argument purely to log it.
    bindTrace({ userId: req.principal.userId });
    return true;
  }
}
