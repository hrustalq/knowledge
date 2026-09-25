import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CreateApiKeyResponse,
  ListApiKeysResponse,
  MeResponse,
  RotateApiKeyResponse,
  WorkspaceRole,
} from '@knowledge/contracts';
import { CurrentPrincipal } from './access.decorator.js';
import { AccessService } from './access.service.js';
import type { Principal } from './principal.js';
import { UpdateMeDto } from './me.dto.js';
import { CreateApiKeyDto } from './api-keys.dto.js';
import { ApiKeysService } from './api-keys.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

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
  ) {}

  @Patch()
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

  private async meOf(principal: Principal): Promise<MeResponse> {
    const memberships = await this.access.memberships(principal);
    return {
      userId: principal.userId,
      email: principal.email,
      displayName: principal.displayName,
      avatarUrl: principal.avatarUrl,
      mode: principal.mode,
      isAdmin: principal.isAdmin,
      locale: principal.locale,
      memberships: memberships.map((m) => ({
        workspaceId: m.workspaceId,
        role: m.role as WorkspaceRole,
        trustedOperator: m.trustedOperator,
      })),
    };
  }
}
