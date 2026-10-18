import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  IdentityProviderView,
  ListIdentityProvidersResponse,
  TestIdentityProviderResponse,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../access.decorator.js';
import type { Principal } from '../principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../../common/validation.js';
import { CreateIdentityProviderDto, UpdateIdentityProviderDto } from './identity-providers.dto.js';
import { IdentityProvidersService } from './identity-providers.service.js';
import { SsoEnabledGuard } from './sso-enabled.guard.js';

/** A workspace's identity providers (#75), Settings → Security → Providers. Workspace admins only. */
@ApiTags('auth')
@Controller('v1/workspaces')
@UseGuards(SsoEnabledGuard)
export class IdentityProvidersController {
  constructor(private readonly providers: IdentityProvidersService) {}

  @Get(':id/identity-providers')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: "The workspace's identity providers. Client secrets are never returned (hasSecret only)" })
  list(@Param('id', ParseUUIDPipe) id: string): Promise<ListIdentityProvidersResponse> {
    return this.providers.list(id);
  }

  @Post(':id/identity-providers')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Add an OIDC provider (starts disabled). 400 secretKeyMissing without SETTINGS_ENCRYPTION_KEY' })
  create(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateIdentityProviderDto,
  ): Promise<IdentityProviderView> {
    return this.providers.create(id, dto, principal);
  }

  @Patch(':id/identity-providers/:providerId')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: "Change a provider. clientSecret: a value sets it, '' clears it, absent keeps it" })
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Body() dto: UpdateIdentityProviderDto,
  ): Promise<IdentityProviderView> {
    return this.providers.update(id, providerId, dto, principal);
  }

  @Delete(':id/identity-providers/:providerId')
  @HttpCode(204)
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Remove a provider, its identity links, and the sessions it opened' })
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('providerId', ParseUUIDPipe) providerId: string,
  ): Promise<void> {
    return this.providers.remove(id, providerId, principal);
  }

  @Post(':id/identity-providers/:providerId/test')
  @HttpCode(200)
  @Access('admin', 'workspace')
  @ApiOperation({ summary: "Fetch the provider's discovery document and report what it names" })
  test(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('providerId', ParseUUIDPipe) providerId: string,
  ): Promise<TestIdentityProviderResponse> {
    return this.providers.test(id, providerId);
  }
}
