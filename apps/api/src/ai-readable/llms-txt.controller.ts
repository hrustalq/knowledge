import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import { AccessService } from '../auth/access.service.js';
import { AuditService } from '../auth/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { AiReadableService, type FullPlan, type TextResult } from './ai-readable.service.js';
import { renderHub, type HubWorkspace } from './llms.js';
import { etagMatches } from './render.js';

/**
 * Authenticated content: never in a shared cache, never indexed, never sniffed
 * as HTML. `Vary` names the credentials because the body depends on who asks.
 */
function textHeaders(res: Response, etag?: string): void {
  if (etag) res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('Vary', 'Authorization, Cookie');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendText(res: Response, result: TextResult): void {
  textHeaders(res, result.etag);
  if (result.status === 304) {
    res.status(304).end();
    return;
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(200).send(result.body);
}

/**
 * llms.txt / llms-full.txt (issue #68, phase 2) — the llmstxt.org surface over
 * the caller's workspace, under the same ACL as reading a page. Every scoped
 * route has `@Access('viewer', …)`, so a cross-tenant or pinned-elsewhere key
 * 403s in AclGuard before PG is queried for content. The hub has no single
 * workspace to resolve, so it runs `requireRole` per workspace by hand.
 */
@ApiTags('ai-readable')
@Controller('v1')
export class LlmsTxtController {
  constructor(
    private readonly aiReadable: AiReadableService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  @Get('llms.txt')
  @ApiProduces('text/plain')
  @ApiOperation({ summary: 'Hub: one section per workspace the caller can read, linking to its llms.txt files (issue #68)' })
  async hub(@CurrentPrincipal() principal: Principal, @Res() res: Response): Promise<void> {
    this.aiReadable.assertEnabled();
    const workspaces = await this.readableWorkspaces(principal);
    textHeaders(res);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(renderHub(this.aiReadable.apiBase(), workspaces));
  }

  @Get('workspaces/:id/llms.txt')
  @Access('viewer', 'workspace')
  @ApiProduces('text/plain')
  @ApiOperation({ summary: 'llms.txt index of a workspace: a section per project, pages in tree order (issue #68)' })
  @ApiResponse({ status: 304, description: 'Unchanged since the ETag sent in If-None-Match' })
  async workspaceIndex(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    this.aiReadable.assertEnabled();
    sendText(res, await this.aiReadable.workspaceIndex(id, req.headers['if-none-match']));
  }

  @Get('workspaces/:id/llms-full.txt')
  @Access('viewer', 'workspace')
  @ApiProduces('text/plain')
  @ApiOperation({
    summary:
      'Every readable page of a workspace concatenated, streamed and capped (LLMS_FULL_MAX_DOCS / _BYTES). Audited (issue #68)',
  })
  @ApiResponse({ status: 304, description: 'Unchanged since the ETag sent in If-None-Match' })
  async workspaceFull(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    this.aiReadable.assertEnabled();
    const plan = await this.aiReadable.workspaceFullPlan(id);
    await this.streamFull(res, req, principal, plan, id, { workspaceId: id });
  }

  @Get('projects/:id/llms.txt')
  @Access('viewer', 'project')
  @ApiProduces('text/plain')
  @ApiOperation({ summary: 'llms.txt index of one project, pages in tree order (issue #68)' })
  @ApiResponse({ status: 304, description: 'Unchanged since the ETag sent in If-None-Match' })
  async projectIndex(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    this.aiReadable.assertEnabled();
    sendText(res, await this.aiReadable.projectIndex(id, req.headers['if-none-match']));
  }

  @Get('projects/:id/llms-full.txt')
  @Access('viewer', 'project')
  @ApiProduces('text/plain')
  @ApiOperation({ summary: 'Every readable page of one project concatenated, streamed and capped. Audited (issue #68)' })
  @ApiResponse({ status: 304, description: 'Unchanged since the ETag sent in If-None-Match' })
  async projectFull(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    this.aiReadable.assertEnabled();
    const plan = await this.aiReadable.projectFullPlan(id);
    await this.streamFull(res, req, principal, plan, plan.workspaceId, { projectId: id });
  }

  /**
   * The status is committed before the first page is read, so everything after
   * this point reports in-band. A bulk export is audited (one row, after the
   * stream ends); a 304 moved no content and is not.
   */
  private async streamFull(
    res: Response,
    req: Request,
    principal: Principal | undefined,
    plan: FullPlan,
    workspaceId: string,
    scope: Record<string, string>,
  ): Promise<void> {
    textHeaders(res, plan.etag);
    if (etagMatches(req.headers['if-none-match'], plan.etag)) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200);
    const started = Date.now();
    const stats = await this.aiReadable.streamFull(plan, res);
    res.end();
    await this.audit.record({
      workspaceId,
      actor: !principal || principal.mode === 'dev' ? 'dev' : principal.userId,
      action: 'ai-readable.llms-full',
      params: { ...scope, apiKeyId: principal?.apiKey?.id ?? null, ...stats },
      rowCount: stats.pages,
      durationMs: Date.now() - started,
      ok: true,
    });
  }

  /** Candidates from the service, then the real `requireRole` each — key narrowing is the guard's, not a copy. */
  private async readableWorkspaces(principal: Principal): Promise<HubWorkspace[]> {
    const out: HubWorkspace[] = [];
    for (const w of await this.aiReadable.hubCandidates(principal)) {
      const ok = await this.access.requireRole(principal, w.workspaceId, 'viewer').then(
        () => true,
        () => false,
      );
      if (ok) out.push(w);
    }
    return out;
  }
}

