import { Controller, Get, Query } from '@nestjs/common';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { ListAuditLogsResponse, MeResponse, WorkspaceRole } from '@knowledge/contracts';
import { Access, CurrentPrincipal } from './access.decorator.js';
import { AccessService } from './access.service.js';
import { AuditService } from './audit.service.js';
import type { Principal } from './principal.js';

@ApiTags('auth')
@Controller('v1')
export class AuthController {
  constructor(
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Resolved caller identity + workspace memberships (Phase 5)' })
  async me(@CurrentPrincipal() principal: Principal): Promise<MeResponse> {
    const memberships = await this.access.memberships(principal);
    return {
      userId: principal.userId,
      email: principal.email,
      displayName: principal.displayName,
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
