import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CreateApiKeyResponse,
  ListApiKeysResponse,
  ListSessionsResponse,
  MeResponse,
  RotateApiKeyResponse,
} from '@knowledge/contracts';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { toMeResponse } from './me-response.js';
import { CurrentPrincipal, UnverifiedOk } from './access.decorator.js';
import { AccessService } from './access.service.js';
import type { Principal } from './principal.js';
import { UpdateMeDto } from './me.dto.js';
import { CreateApiKeyDto } from './api-keys.dto.js';
import { ApiKeysService } from './api-keys.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsService } from './sessions.service.js';
import { AuditService } from './audit.service.js';
import { requestMeta } from '../common/client-ip.js';
import { t } from '../i18n/t.js';

/**
 * The caller's own account.
 *
 * Split from AuthController because that one is read-only identity plus the
 * admin audit log; this writes to `users`, and the two want different
 * dependencies. Everything here acts on `principal.userId` and never takes an
 * id, which is what keeps it out of @PlatformAdmin territory: there is no
 * parameter to point at somebody else.
 */
@ApiTags('auth')
@Controller('v1/me')
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly apiKeys: ApiKeysService,
    private readonly config: ConfigService<Env, true>,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  @Patch()
  // Changing the language is how a Russian speaker gets a verify mail they can read.
  @UnverifiedOk()
  @ApiOperation({ summary: "Update the caller's own display name and language (docs/features/18)" })
  async update(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: UpdateMeDto,
  ): Promise<MeResponse> {
    const displayName = dto.displayName?.trim();
    const next: Principal = {
      ...principal,
      ...(displayName ? { displayName } : {}),
      ...(dto.locale ? { locale: dto.locale } : {}),
    };

    // The dev principal has no users row to write to. Answering with the
    // updated identity anyway keeps AUTH_MODE=none behaving like the real
    // thing for one request, which is what the language switcher expects; the
    // durable copy in that mode is the kn_lang cookie.
    if (principal.mode !== 'dev' && (displayName || dto.locale)) {
      await this.prisma.user.update({
        where: { id: principal.userId },
        data: {
          ...(displayName ? { displayName } : {}),
          ...(dto.locale ? { locale: dto.locale } : {}),
        },
      });
    }
    return this.meOf(next);
  }

  @Post('api-key')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Deprecated — revoke every key the caller has and mint one full-scope key (use /v1/me/api-keys)',
    deprecated: true,
  })
  async rotateApiKey(@CurrentPrincipal() principal: Principal): Promise<RotateApiKeyResponse> {
    const { apiKey, key } = await this.apiKeys.rotate(principal);
    return { apiKey, rotatedAt: key.createdAt };
  }

  @Get('api-keys')
  @ApiOperation({ summary: "The caller's active API keys (docs/features/33) — names and prefixes, never the keys" })
  listApiKeys(@CurrentPrincipal() principal: Principal): Promise<ListApiKeysResponse> {
    return this.apiKeys.list(principal);
  }

  @Post('api-keys')
  @ApiOperation({ summary: 'Mint a named API key, optionally read-only, workspace-pinned or expiring (shown once)' })
  createApiKey(@CurrentPrincipal() principal: Principal, @Body() dto: CreateApiKeyDto): Promise<CreateApiKeyResponse> {
    return this.apiKeys.create(principal, dto);
  }

  @Delete('api-keys/:keyId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke one of the caller\'s API keys; clients using it get 401 from the next request' })
  async revokeApiKey(
    @CurrentPrincipal() principal: Principal,
    @Param('keyId', ParseUUIDPipe) keyId: string,
  ): Promise<void> {
    await this.apiKeys.revoke(principal, keyId);
  }

  /** The caller's live sign-ins (#75): where and how each was opened, and when last used. */
  @Get('sessions')
  @UnverifiedOk()
  @ApiOperation({ summary: "The caller's live login sessions — method, IP, user agent, last seen; never the tokens" })
  async listSessions(@CurrentPrincipal() principal: Principal): Promise<ListSessionsResponse> {
    // The dev principal and an API key have no users row of sessions to show.
    if (principal.mode === 'dev') return { sessions: [] };
    return { sessions: await this.sessions.listForUser(principal.userId, principal.sessionId) };
  }

  /**
   * Sign one of the caller's sessions out — the current one included, which is
   * a logout. Another person's session id reads as unknown: the revoke is one
   * statement guarded by the caller's user id.
   */
  @Delete('sessions/:sessionId')
  @HttpCode(204)
  @UnverifiedOk()
  @ApiOperation({ summary: "Revoke one of the caller's sessions; its token gets 401 from the next request" })
  async revokeSession(
    @CurrentPrincipal() principal: Principal,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Req() req: Request,
  ): Promise<void> {
    if (principal.mode === 'dev' || !(await this.sessions.revokeOwn(principal.userId, sessionId))) {
      throw new NotFoundException(t('error.auth.sessionNotFound'));
    }
    void this.audit.record({
      workspaceId: null,
      actor: principal.userId,
      action: 'auth.session_revoked',
      params: { sessionId, by: 'self' },
      ok: true,
      ip: requestMeta(req).ip,
      target: principal.userId,
    });
  }

  private async meOf(principal: Principal): Promise<MeResponse> {
    return toMeResponse(
      principal,
      await this.access.memberships(principal),
      this.config.get('AUTH_REQUIRE_VERIFIED_EMAIL', { infer: true }),
    );
  }

}
