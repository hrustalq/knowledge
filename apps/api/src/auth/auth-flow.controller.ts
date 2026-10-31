import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AuthSessionResponse,
  ForgotPasswordResponse,
  LogoutResponse,
  ResendVerificationResponse,
  ResetPasswordResponse,
  SessionCookieResponse,
  UrlTicketResponse,
  VerifyEmailResponse,
} from '@knowledge/contracts';
import { CurrentPrincipal, Public, ReadKeyOk, UnverifiedOk } from './access.decorator.js';
import { AuthFlowService } from './auth-flow.service.js';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  ResetPasswordDto,
  SignupDto,
  VerifyEmailDto,
} from './auth-flow.dto.js';
import type { Principal } from './principal.js';
import { UrlTicketsService } from './url-tickets.service.js';
import { SessionsService } from './sessions.service.js';
import { clearSessionCookie, setSessionCookie } from './session-cookie.js';
import type { Env } from '../config/env.js';
import { requestMeta } from '../common/client-ip.js';
import { AuthRateLimit, AuthRateLimitGuard } from './auth-rate-limit.guard.js';
import { Returns } from '../common/returns.decorator.js';
import { CachePolicy } from '../common/http-cache.js';

/**
 * Auth flow endpoints. signup/login/forgot/reset are @Public (they mint the
 * credentials AuthGuard later checks); logout/change-password require auth.
 * Works in both AUTH_MODEs — in 'none' the session is created but unused.
 */
@ApiTags('auth')
// Sessions, keys and sign-in answers carry credentials: never kept (#472).
@CachePolicy('no-store')
@Controller('v1/auth')
export class AuthFlowController {
  constructor(
    private readonly flow: AuthFlowService,
    private readonly tickets: UrlTicketsService,
    private readonly sessions: SessionsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private webBaseUrl(): string {
    return this.config.get('WEB_BASE_URL', { infer: true });
  }

  @Public()
  @Post('signup')
  @Returns('AuthSessionResponse')
  @ApiOperation({ summary: 'Create an account with email + password; sets the HttpOnly kn_token session cookie' })
  async signup(
    @Body() dto: SignupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionResponse> {
    const issued = await this.flow.signup(dto.email, dto.displayName, dto.password, requestMeta(req));
    return setSessionCookie(res, issued, this.webBaseUrl());
  }

  @Public()
  @HttpCode(200)
  @Post('login')
  @Returns('AuthSessionResponse')
  @UseGuards(AuthRateLimitGuard)
  @AuthRateLimit('login')
  @ApiOperation({
    summary: 'Email + password login; sets the HttpOnly kn_token session cookie. 429 past 30/min per IP or 10/min per address',
  })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionResponse> {
    const issued = await this.flow.login(dto.email, dto.password, requestMeta(req));
    return setSessionCookie(res, issued, this.webBaseUrl());
  }

  @HttpCode(200)
  @Post('logout')
  @Returns('LogoutResponse')
  @UnverifiedOk()
  @ApiOperation({ summary: 'Revoke the current session and clear its cookie (no-op for API keys / dev mode)' })
  async logout(
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LogoutResponse> {
    await this.flow.logout(principal, requestMeta(req));
    clearSessionCookie(res, this.webBaseUrl());
    return { ok: true };
  }

  /**
   * #650 migration. A browser signed in before the session moved into an
   * HttpOnly cookie still holds its `ks_` token in localStorage: it sends it
   * here once as a bearer header, gets the cookie, and forgets its copy, so
   * nobody is signed out by the deploy. Only a live `ks_` session presented
   * as a header qualifies, never an API key: an API key in a cookie would
   * authenticate every cross-site navigation as that key.
   */
  // ponytail: one-release bridge; delete with the web's adoptLegacySession once a session TTL (30 days) has passed after the release that ships it
  @HttpCode(200)
  @Post('session-cookie')
  @Returns('SessionCookieResponse')
  @UnverifiedOk()
  @ApiOperation({ summary: 'Move a pre-#650 bearer ks_ session into the HttpOnly kn_token cookie (one-release migration)' })
  async sessionCookie(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<SessionCookieResponse> {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const session = token.startsWith('ks_') ? await this.sessions.resolve(token) : null;
    if (!session) return { ok: false };
    setSessionCookie(res, { token, expiresAt: session.expiresAt.toISOString() }, this.webBaseUrl());
    return { ok: true };
  }

  @Public()
  @HttpCode(200)
  @Post('forgot-password')
  @Returns('ForgotPasswordResponse')
  @ApiOperation({ summary: 'Request a password-reset token (never reveals whether the email exists)' })
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<ForgotPasswordResponse> {
    return this.flow.forgotPassword(dto.email);
  }

  @Public()
  @HttpCode(200)
  @Post('reset-password')
  @Returns('ResetPasswordResponse')
  @ApiOperation({ summary: 'Set a new password with a kr_ reset token; revokes all sessions' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<ResetPasswordResponse> {
    await this.flow.resetPassword(dto.token, dto.password);
    return { ok: true };
  }

  @Public()
  @HttpCode(200)
  @Post('verify-email')
  @Returns('VerifyEmailResponse')
  @ApiOperation({ summary: 'Confirm the account address with the kv_ token from the mailed link (docs/features/41)' })
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<VerifyEmailResponse> {
    await this.flow.verifyEmail(dto.token);
    return { ok: true };
  }

  @HttpCode(200)
  @Post('resend-verification')
  @Returns('ResendVerificationResponse')
  @UnverifiedOk()
  @ApiOperation({ summary: "Mail a fresh confirmation link to the caller's address (at most one a minute)" })
  resendVerification(@CurrentPrincipal() principal: Principal): Promise<ResendVerificationResponse> {
    return this.flow.resendVerification(principal);
  }

  /**
   * #102: swap the caller's credential (a header, or the browser's session
   * cookie, #650) for a single-use, ~60 s `kt_` ticket to put in `?token=` on
   * a `@QueryTokenOk` route (the SSE stream), on the `/v1/events/ws` upgrade,
   * or in a `/v1/collab` provider's token (#80), so the long-lived session
   * token or API key never appears in a URL or crosses that socket. The ticket
   * carries the principal as resolved now, API-key narrowing included, so it
   * can never reach more than the credential that minted it.
   *
   * A ticket cannot mint one: this route is not `@QueryTokenOk`, so a ticket
   * cannot be traded for a fresh ticket. `@ReadKeyOk` because POST here is
   * transport — a read-only key needs the stream as much as a write key does.
   */
  @HttpCode(200)
  @Post('url-ticket')
  @Returns('UrlTicketResponse')
  @ReadKeyOk()
  @ApiOperation({
    summary:
      'Mint a single-use, short-lived kt_ ticket for ?token= on SSE (EventSource cannot set headers) and for joining /v1/collab; API keys are refused in URLs',
  })
  urlTicket(@CurrentPrincipal() principal: Principal): Promise<UrlTicketResponse> {
    return this.tickets.mint(principal);
  }

  @HttpCode(200)
  @Post('change-password')
  @Returns('ResetPasswordResponse')
  @ApiOperation({ summary: 'Change own password (requires the current one); revokes other sessions' })
  async changePassword(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: ChangePasswordDto,
  ): Promise<ResetPasswordResponse> {
    await this.flow.changePassword(principal, dto.currentPassword, dto.newPassword);
    return { ok: true };
  }
}
