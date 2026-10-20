import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AuthSessionResponse,
  ForgotPasswordResponse,
  LogoutResponse,
  ResendVerificationResponse,
  ResetPasswordResponse,
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
import { requestMeta } from '../common/client-ip.js';
import { AuthRateLimit, AuthRateLimitGuard } from './auth-rate-limit.guard.js';

/**
 * Auth flow endpoints. signup/login/forgot/reset are @Public (they mint the
 * credentials AuthGuard later checks); logout/change-password require auth.
 * Works in both AUTH_MODEs — in 'none' the session is created but unused.
 */
@ApiTags('auth')
@Controller('v1/auth')
export class AuthFlowController {
  constructor(
    private readonly flow: AuthFlowService,
    private readonly tickets: UrlTicketsService,
  ) {}

  @Public()
  @Post('signup')
  @ApiOperation({ summary: 'Create an account with email + password; returns a ks_ session token' })
  signup(@Body() dto: SignupDto, @Req() req: Request): Promise<AuthSessionResponse> {
    return this.flow.signup(dto.email, dto.displayName, dto.password, requestMeta(req));
  }

  @Public()
  @HttpCode(200)
  @Post('login')
  @UseGuards(AuthRateLimitGuard)
  @AuthRateLimit('login')
  @ApiOperation({ summary: 'Email + password login; returns a ks_ session token. 429 past 30/min per IP or 10/min per address' })
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<AuthSessionResponse> {
    return this.flow.login(dto.email, dto.password, requestMeta(req));
  }

  @HttpCode(200)
  @Post('logout')
  @UnverifiedOk()
  @ApiOperation({ summary: 'Revoke the current session token (no-op for API keys / dev mode)' })
  async logout(@CurrentPrincipal() principal: Principal, @Req() req: Request): Promise<LogoutResponse> {
    await this.flow.logout(principal, requestMeta(req));
    return { ok: true };
  }

  @Public()
  @HttpCode(200)
  @Post('forgot-password')
  @ApiOperation({ summary: 'Request a password-reset token (never reveals whether the email exists)' })
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<ForgotPasswordResponse> {
    return this.flow.forgotPassword(dto.email);
  }

  @Public()
  @HttpCode(200)
  @Post('reset-password')
  @ApiOperation({ summary: 'Set a new password with a kr_ reset token; revokes all sessions' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<ResetPasswordResponse> {
    await this.flow.resetPassword(dto.token, dto.password);
    return { ok: true };
  }

  @Public()
  @HttpCode(200)
  @Post('verify-email')
  @ApiOperation({ summary: 'Confirm the account address with the kv_ token from the mailed link (docs/features/41)' })
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<VerifyEmailResponse> {
    await this.flow.verifyEmail(dto.token);
    return { ok: true };
  }

  @HttpCode(200)
  @Post('resend-verification')
  @UnverifiedOk()
  @ApiOperation({ summary: "Mail a fresh confirmation link to the caller's address (at most one a minute)" })
  resendVerification(@CurrentPrincipal() principal: Principal): Promise<ResendVerificationResponse> {
    return this.flow.resendVerification(principal);
  }

  /**
   * #102: swap the caller's header credential for a single-use, ~60 s `kt_`
   * ticket to put in `?token=` on a `@QueryTokenOk` route (the SSE stream), or
   * in a `/v1/collab` provider's token (#80), so the long-lived session token
   * or API key never appears in a URL or crosses that socket. The ticket
   * carries the principal as resolved now, API-key narrowing included, so it
   * can never reach more than the credential that minted it.
   *
   * Only a header mints one: this route is not `@QueryTokenOk`, so a ticket
   * cannot be traded for a fresh ticket. `@ReadKeyOk` because POST here is
   * transport — a read-only key needs the stream as much as a write key does.
   */
  @HttpCode(200)
  @Post('url-ticket')
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
  @ApiOperation({ summary: 'Change own password (requires the current one); revokes other sessions' })
  async changePassword(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: ChangePasswordDto,
  ): Promise<ResetPasswordResponse> {
    await this.flow.changePassword(principal, dto.currentPassword, dto.newPassword);
    return { ok: true };
  }
}
