import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  ListKnowledgeIssuesResponse,
  ReportKnowledgeIssueResponse,
  UpdateKnowledgeIssueResponse,
} from '@knowledge/contracts';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { KnowledgeIssuesService } from './knowledge-issues.service.js';
import { CloseKnowledgeIssueDto, ListKnowledgeIssuesQueryDto, ReportKnowledgeIssueDto } from './knowledge-issues.dto.js';

/**
 * Reports against pages (docs/features/38, issue #67 phase 3).
 *
 * Filing is `viewer`: anyone who may read a page may say it is wrong, and a
 * read-only API key is admitted for the same reason the vote routes admit it.
 * Closing is `editor`, resolved through the issue's own row so a cross-tenant
 * id 403s before the handler runs.
 */
@ApiTags('knowledge-issues')
@Controller('v1/knowledge-issues')
export class KnowledgeIssuesController {
  constructor(private readonly issues: KnowledgeIssuesService) {}

  @Post()
  @Access('viewer', 'body')
  @ApiOperation({
    summary:
      'Report a problem with a page. Folds into the open issue for the same page and kind; otherwise opens a draft ' +
      'merge request (editor with a corrected body), queues a sentinel check, or stays open for a person.',
  })
  async report(
    @Body() dto: ReportKnowledgeIssueDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ReportKnowledgeIssueResponse> {
    return this.issues.report({ ...dto, surface: dto.surface ?? 'web' }, principal);
  }

  @Get()
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'List reports in a workspace, newest first; narrow by page or status' })
  async list(@Query() query: ListKnowledgeIssuesQueryDto): Promise<ListKnowledgeIssuesResponse> {
    return this.issues.list(query.workspaceId, { documentId: query.documentId, status: query.status });
  }

  @Patch(':id')
  @Access('editor', 'knowledge-issue')
  @ApiOperation({ summary: 'Close a report by hand: resolved (the page is right now) or dismissed (the report was not)' })
  async close(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseKnowledgeIssueDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<UpdateKnowledgeIssueResponse> {
    return { issue: await this.issues.close(id, dto.status, principal) };
  }
}
