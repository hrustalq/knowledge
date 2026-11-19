import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { ListAuditLogsResponse, ListPlatformAuditLogsResponse, MeResponse } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { Access, CurrentPrincipal, PlatformAdmin, UnverifiedOk } from './access.decorator.js';
import { toMeResponse } from './me-response.js';
import { AccessService } from './access.service.js';
import { AuditService, type AuditListFilter } from './audit.service.js';
import {
  AuditExportQueryDto,
  AuditPageQueryDto,
  type AuditFilterQueryDto,
  WorkspaceAuditExportQueryDto,
  WorkspaceAuditPageQueryDto,
} from './audit.dto.js';
import { toCsv } from '../analytics/analytics-csv.js';
import type { Principal } from './principal.js';
import { Returns } from '../common/returns.decorator.js';
import { CachePolicy } from '../common/http-cache.js';

@ApiTags('auth')
// Sessions, keys and sign-in answers carry credentials: never kept (#472).
@CachePolicy('no-store')
@Controller('v1')
export class AuthController {
  constructor(
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get('me')
  @Returns('MeResponse')
  @ApiOperation({ summary: 'Resolved caller identity + workspace memberships (Phase 5)' })
  @UnverifiedOk()
  async me(@CurrentPrincipal() principal: Principal): Promise<MeResponse> {
    return toMeResponse(
      principal,
      await this.access.memberships(principal),
      this.config.get('AUTH_REQUIRE_VERIFIED_EMAIL', { infer: true }),
      this.config.get('AUTH_SIGNUP_ENABLED', { infer: true }),
    );
  }

  @Get('audit-logs')
  @Returns('ListAuditLogsResponse')
  @Access('admin', 'query')
  @ApiOperation({ summary: "Workspace audit trail, newest first (admin), filtered by action, category, actor, target, dates and outcome" })
  async auditLogs(@Query() q: WorkspaceAuditPageQueryDto): Promise<ListAuditLogsResponse> {
    const page = await this.audit.list(q.workspaceId, auditFilterOf(q));
    return { workspaceId: q.workspaceId, ...page };
  }

  @Get('audit-logs/export')
  @Access('admin', 'query')
  @ApiProduces('text/csv', 'application/json')
  @ApiOperation({ summary: "The filtered workspace trail as CSV or JSON (admin, capped); the export is itself audited" })
  async exportAuditLogs(
    @Query() q: WorkspaceAuditExportQueryDto,
    @CurrentPrincipal() principal: Principal,
    @Res() res: Response,
  ): Promise<void> {
    await this.sendExport(res, q.workspaceId, q, principal);
  }

  /**
   * Every workspace's trail plus the platform's own events — the sign-ins,
   * which belong to no workspace (#75). Platform admins only: it crosses
   * every tenant boundary at once.
   */
  @Get('admin/audit-logs')
  @Returns('ListPlatformAuditLogsResponse')
  @PlatformAdmin()
  @ApiOperation({ summary: 'Platform audit trail incl. sign-ins and other workspace-less events (platform admin)' })
  platformAuditLogs(@Query() q: AuditPageQueryDto): Promise<ListPlatformAuditLogsResponse> {
    return this.audit.listPlatform(auditFilterOf(q));
  }

  @Get('admin/audit-logs/export')
  @PlatformAdmin()
  @ApiProduces('text/csv', 'application/json')
  @ApiOperation({ summary: 'The filtered platform trail as CSV or JSON (platform admin, capped); audited' })
  async exportPlatformAuditLogs(
    @Query() q: AuditExportQueryDto,
    @CurrentPrincipal() principal: Principal,
    @Res() res: Response,
  ): Promise<void> {
    await this.sendExport(res, null, q, principal);
  }

  /** One body for both exports (#1251): the listing's filter, a row cap, and an audit row for what left. */
  private async sendExport(res: Response, workspaceId: string | null, q: AuditExportQueryDto, principal: Principal): Promise<void> {
    const started = Date.now();
    const filter = auditFilterOf(q);
    const { entries, truncated } = await this.audit.exportRows(workspaceId, filter);
    await this.audit.record({
      workspaceId,
      actor: principal.mode === 'dev' ? 'dev' : principal.userId,
      action: 'audit.exported',
      params: { format: q.format, filter, truncated, apiKeyId: principal.apiKey?.id ?? null },
      rowCount: entries.length,
      durationMs: Date.now() - started,
      ok: true,
    });
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="audit-${day}.${q.format}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The cap is stated, never silent: the JSON says so in the body, both say so in a header.
    res.setHeader('X-Audit-Truncated', String(truncated));
    if (q.format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(200).send(JSON.stringify({ workspaceId, filter, truncated, entries }, null, 2));
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    const columns = ['createdAt', 'workspaceId', 'action', 'actor', 'target', 'ok', 'error', 'ip', 'rowCount', 'durationMs', 'params'] as const;
    res.status(200).send(toCsv(columns, entries.map((e) => columns.map((c) => (c === 'params' ? JSON.stringify(e.params) : e[c])))));
  }
}

/** The query as the service reads it: dates parsed, `ok` a boolean, the page fields passed through. */
function auditFilterOf(q: AuditFilterQueryDto & { limit?: number; cursor?: string }): AuditListFilter {
  return {
    action: q.action,
    category: q.category,
    actor: q.actor,
    target: q.target,
    from: q.from ? new Date(q.from) : undefined,
    to: q.to ? new Date(q.to) : undefined,
    ok: q.ok === undefined ? undefined : q.ok === 'true',
    limit: q.limit,
    cursor: q.cursor,
  };
}
