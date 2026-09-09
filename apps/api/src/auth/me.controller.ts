import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, Body, Controller, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { MeResponse, RotateApiKeyResponse, WorkspaceRole } from '@knowledge/contracts';
import { CurrentPrincipal } from './access.decorator.js';
import { AccessService } from './access.service.js';
import type { Principal } from './principal.js';
import { UpdateMeDto } from './me.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
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
    summary: "Mint a fresh API key for the caller, replacing any existing one (shown once)",
  })
  async rotateApiKey(@CurrentPrincipal() principal: Principal): Promise<RotateApiKeyResponse> {
    if (principal.mode === 'dev') throw new BadRequestException(t('error.auth.noApiKeyInDevMode'));
    // Same shape and storage rule as `make auth-bootstrap`: 24 random bytes,
    // and only the SHA-256 ever reaches PostgreSQL. Rotating invalidates the
    // previous key by overwriting its hash — there is one key per user, so
    // there is nothing to select between.
    const apiKey = `kn_${randomBytes(24).toString('hex')}`;
    await this.prisma.user.update({
      where: { id: principal.userId },
      data: { apiKeyHash: createHash('sha256').update(apiKey).digest('hex') },
    });
    return { apiKey, rotatedAt: new Date().toISOString() };
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
