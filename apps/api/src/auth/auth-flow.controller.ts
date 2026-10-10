import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AuthSessionResponse,
  ForgotPasswordResponse,
  LogoutResponse,
  ResetPasswordResponse,
  UrlTicketResponse,
} from '@knowledge/contracts';
import { CurrentPrincipal, Public, ReadKeyOk } from './access.decorator.js';
import { AuthFlowService } from './auth-flow.service.js';
import { ChangePasswordDto, ForgotPasswordDto, LoginDto, ResetPasswordDto, SignupDto } from './auth-flow.dto.js';
import type { Principal } from './principal.js';
import { UrlTicketsService } from './url-tickets.service.js';

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
  signup(@Body() dto: SignupDto): Promise<AuthSessionResponse> {
    return this.flow.signup(dto.email, dto.displayName, dto.password);
  }

  @Public()
  @HttpCode(200)
  @Post('login')
  @ApiOperation({ summary: 'Email + password login; returns a ks_ session token' })
  login(@Body() dto: LoginDto): Promise<AuthSessionResponse> {
    return this.flow.login(dto.email, dto.password);
  }

  @HttpCode(200)
  @Post('logout')
  @ApiOperation({ summary: 'Revoke the current session token (no-op for API keys / dev mode)' })
  async logout(@CurrentPrincipal() principal: Principal): Promise<LogoutResponse> {
    await this.flow.logout(principal);
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

  /**
   * #102: swap the caller's header credential for a single-use, ~60 s `kt_`
   * ticket to put in `?token=` on a `@QueryTokenOk` route (the SSE stream), so
   * the long-lived session token or API key never appears in a URL. The ticket
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
      'Mint a single-use, short-lived kt_ ticket for ?token= on SSE (EventSource cannot set headers); API keys are refused in URLs',
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
