import { Controller, Get, Query } from '@nestjs/common';
import { OptionalUuidPipe, ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { ListAuditLogsResponse, ListPlatformAuditLogsResponse, MeResponse } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { Access, CurrentPrincipal, PlatformAdmin, UnverifiedOk } from './access.decorator.js';
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
  @ApiOperation({ summary: "Workspace audit trail, newest first (admin) — graph queries, ACL changes, the workspace's sign-in config" })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'action', required: false, description: 'One AUDIT_ACTIONS value' })
  @ApiQuery({ name: 'cursor', required: false, description: 'nextCursor from the previous page' })
  async auditLogs(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
    @Query('cursor', OptionalUuidPipe) cursor?: string,
  ): Promise<ListAuditLogsResponse> {
    const page = await this.audit.list(workspaceId, { limit: limit ? Number(limit) : 50, action, cursor });
    return { workspaceId, ...page };
  }

  /**
   * Every workspace's trail plus the platform's own events — the sign-ins,
   * which belong to no workspace (#75). Platform admins only: it crosses
   * every tenant boundary at once.
   */
  @Get('admin/audit-logs')
  @PlatformAdmin()
  @ApiOperation({ summary: 'Platform audit trail incl. sign-ins and other workspace-less events (platform admin)' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'action', required: false, description: 'One AUDIT_ACTIONS value' })
  @ApiQuery({ name: 'cursor', required: false, description: 'nextCursor from the previous page' })
  platformAuditLogs(
    @Query('limit') limit?: string,
    @Query('action') action?: string,
    @Query('cursor', OptionalUuidPipe) cursor?: string,
  ): Promise<ListPlatformAuditLogsResponse> {
    return this.audit.listPlatform({ limit: limit ? Number(limit) : 50, action, cursor });
  }
}
