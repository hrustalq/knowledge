import { Controller, Get, Query } from '@nestjs/common';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { ListAuditLogsResponse, MeResponse } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { Access, CurrentPrincipal, UnverifiedOk } from './access.decorator.js';
import { toMeResponse } from './me-response.js';
import { AccessService } from './access.service.js';
import { AuditService } from './audit.service.js';
import type { Principal } from './principal.js';

@ApiTags('auth')
@Controller('v1')
export class AuthController {
  constructor(
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Resolved caller identity + workspace memberships (Phase 5)' })
  @UnverifiedOk()
  async me(@CurrentPrincipal() principal: Principal): Promise<MeResponse> {
    return toMeResponse(
      principal,
      await this.access.memberships(principal),
      this.config.get('AUTH_REQUIRE_VERIFIED_EMAIL', { infer: true }),
    );
  }

  @Get('audit-logs')
  @Access('admin', 'query')
  @ApiOperation({ summary: 'Workspace audit trail — operator graph queries (admin only, Phase 5)' })
  @ApiQuery({ name: 'limit', required: false })
  async auditLogs(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('limit') limit?: string,
  ): Promise<ListAuditLogsResponse> {
    return { workspaceId, entries: await this.audit.list(workspaceId, limit ? Number(limit) : 50) };
  }
}
