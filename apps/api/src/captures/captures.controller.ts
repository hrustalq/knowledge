import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CaptureInfo, CaptureResult, ListCapturesResponse } from '@knowledge/contracts';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { PermissionService } from '../permissions/permission.service.js';
import { CaptureService } from './capture.service.js';
import { CaptureInboxService } from './capture-inbox.service.js';
import {
  CaptureAssistantMessageDto,
  CreateCaptureDto,
  ListCapturesQueryDto,
  RejectCaptureDto,
  toCaptureRequest,
} from './captures.dto.js';

/**
 * Agent-session captures over REST (issue #73, phase 3) — the same
 * `CaptureService.capture` the MCP capture tools call, plus the inbox.
 *
 * Creating is the one editor route a `capture` key passes (`{ capture: true }`).
 * Approving and rejecting are not flagged, so a capture key is refused there
 * by `requireRole`: what proposes a capture never decides it.
 */
@ApiTags('captures')
@Controller('v1/captures')
export class CapturesController {
  constructor(
    private readonly captures: CaptureService,
    private readonly inbox: CaptureInboxService,
    private readonly permissions: PermissionService,
  ) {}

  @Post()
  @Access('editor', 'body', { capture: true })
  @ApiOperation({
    summary:
      'Stage a capture and propose it: page and relation captures open a merge request with provenance captured, a term waits in the inbox (429 past the rate limits, 400 on a credential)',
  })
  create(@Body() dto: CreateCaptureDto, @CurrentPrincipal() principal: Principal): Promise<CaptureResult> {
    return this.captures.capture(toCaptureRequest(dto), principal);
  }

  @Get()
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Captures in a workspace, newest first; ones on pages or projects the caller cannot open are left out' })
  async list(@Query() query: ListCapturesQueryDto, @CurrentPrincipal() principal: Principal): Promise<ListCapturesResponse> {
    const scope = await this.permissions.scopeFor(principal, query.workspaceId);
    return this.captures.list(
      {
        workspaceId: query.workspaceId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.mine === '1' || query.mine === 'true' ? { createdBy: principal.userId } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      },
      scope,
    );
  }

  @Get(':id')
  @Access('viewer', 'capture')
  @ApiOperation({ summary: 'One capture, with its state read through its merge request' })
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<CaptureInfo> {
    return this.inbox.get(id, principal);
  }

  @Post(':id/approve')
  @Access('editor', 'capture')
  @ApiOperation({
    summary:
      'Approve a term waiting in the inbox: it becomes a glossary entry with source captured. A page or relation capture is approved by merging its merge request (409)',
  })
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<CaptureInfo> {
    return this.inbox.approve(id, principal);
  }

  @Post(':id/reject')
  @Access('editor', 'capture')
  @ApiOperation({
    summary: 'Reject a staged capture. A proposed one is turned down by closing its merge request (409 with mergeRequestId)',
  })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectCaptureDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CaptureInfo> {
    return this.inbox.reject(id, principal, dto.reason);
  }
}

/**
 * "Save to knowledge base" on an assistant reply. Same `v1/assistant` prefix
 * as the chat routes, owned here like AnswerFeedbackController owns votes.
 * The workspace is resolved from the message's thread, so a message from
 * another tenant 403s before the handler runs.
 */
@ApiTags('assistant')
@Controller('v1/assistant')
export class AssistantCaptureController {
  constructor(private readonly inbox: CaptureInboxService) {}

  @Post('messages/:id/capture')
  @Access('editor', 'assistant-message', { capture: true })
  @ApiOperation({
    summary:
      "Write an assistant reply back as an answer capture: its question, its cited pages, a merge request to review (400 when it cites no page)",
  })
  capture(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CaptureAssistantMessageDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CaptureResult> {
    return this.inbox.fromAssistantMessage(id, dto, principal);
  }
}
