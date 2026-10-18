import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  ListSsoDomainsResponse,
  SsoDomainView,
  VerifySsoDomainResponse,
  WorkspaceAuthPolicyView,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal } from '../access.decorator.js';
import { AuthPolicyService } from '../auth-policy.service.js';
import type { Principal } from '../principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../../common/validation.js';
import { ClaimSsoDomainDto, PutAuthPolicyDto, UpdateSsoDomainDto, VerifySsoDomainDto } from './enforcement.dto.js';
import { SsoDomainsService } from './sso-domains.service.js';
import { SsoEnabledGuard } from './sso-enabled.guard.js';

/**
 * A workspace's sign-in policy (#75 phase 4), Settings → Security → Policy.
 * Not behind `SsoEnabledGuard`: the session age cap stands without SSO, and
 * the view says what the instance ceiling leaves of the rest.
 */
@ApiTags('auth')
@Controller('v1/workspaces')
export class AuthPolicyController {
  constructor(private readonly policy: AuthPolicyService) {}

  @Get(':id/auth-policy')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: "The workspace's sign-in policy: what was asked, what applies, and the instance ceilings" })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<WorkspaceAuthPolicyView> {
    return this.policy.view(id);
  }

  @Put(':id/auth-policy')
  @Access('admin', 'workspace')
  @ApiOperation({
    summary: 'Replace the sign-in policy. 409 policyLocksYouOut when the caller would fail it; 400 without a provider to enforce',
  })
  put(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PutAuthPolicyDto,
  ): Promise<WorkspaceAuthPolicyView> {
    return this.policy.put(
      id,
      {
        ssoEnforced: dto.ssoEnforced ?? null,
        allowApiKeys: dto.allowApiKeys ?? null,
        allowPasswordForAdmins: dto.allowPasswordForAdmins ?? null,
        sessionMaxAgeHours: dto.sessionMaxAgeHours ?? null,
      },
      principal,
    );
  }
}

/** Email domains a workspace claims and proves (#75 phase 4), Settings → Security → Domains. */
@ApiTags('auth')
@Controller('v1/workspaces')
@UseGuards(SsoEnabledGuard)
export class SsoDomainsController {
  constructor(private readonly domains: SsoDomainsService) {}

  @Get(':id/sso-domains')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: "The workspace's claimed domains, with the DNS record each one is proven by" })
  list(@CurrentPrincipal() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<ListSsoDomainsResponse> {
    return this.domains.list(id, principal);
  }

  @Post(':id/sso-domains')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Claim a domain. 409 domainTaken when another workspace holds it' })
  claim(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ClaimSsoDomainDto,
  ): Promise<SsoDomainView> {
    return this.domains.claim(id, dto, principal);
  }

  @Post(':id/sso-domains/:domain/verify')
  @HttpCode(200)
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Check the TXT record now. A platform admin may pass manual: true to verify without DNS' })
  verify(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('domain') domain: string,
    @Body() dto: VerifySsoDomainDto,
  ): Promise<VerifySsoDomainResponse> {
    return this.domains.verify(id, domain, principal, dto.manual === true);
  }

  @Patch(':id/sso-domains/:domain')
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Enforce SSO on a verified domain, or change where its people sign in' })
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('domain') domain: string,
    @Body() dto: UpdateSsoDomainDto,
  ): Promise<SsoDomainView> {
    return this.domains.update(id, domain, dto, principal);
  }

  @Delete(':id/sso-domains/:domain')
  @HttpCode(204)
  @Access('admin', 'workspace')
  @ApiOperation({ summary: 'Give up a domain. Its addresses may use passwords again at once' })
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('domain') domain: string,
  ): Promise<void> {
    return this.domains.remove(id, domain, principal);
  }
}
