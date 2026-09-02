import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { AssistantService } from './assistant.service.js';
import { AssistantThreadsService } from './assistant-threads.service.js';
import {
  AssistantAskDto,
  AssistantRelatedDto,
  AssistantReviewDto,
  AssistantSuggestDto,
  CreateAssistantThreadDto,
  PostAssistantMessageDto,
} from './assistant.dto.js';

@ApiTags('assistant')
@Controller('v1/assistant')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly threads: AssistantThreadsService,
  ) {}

  @Post('review')
  @Access('viewer', 'body')
  @ApiOperation({ summary: 'LLM review of a draft (docs/features/09); enabled=false when ASSISTANT_PROVIDER=none' })
  review(@Body() dto: AssistantReviewDto) {
    return this.assistant.review(dto);
  }

  @Post('suggest')
  @Access('viewer', 'body')
  @ApiOperation({ summary: 'LLM writing suggestion for a draft (outline / continuation / rewrite)' })
  suggest(@Body() dto: AssistantSuggestDto) {
    return this.assistant.suggest(dto);
  }

  @Post('ask')
  @Access('viewer', 'body')
  @ApiOperation({
    summary:
      'Chat about a document — tool-calling harness (search/read/graph), every tool call authorized against the caller session',
  })
  ask(@Body() dto: AssistantAskDto, @CurrentPrincipal() principal: Principal) {
    return this.assistant.ask(dto, principal);
  }

  @Post('related')
  @Access('viewer', 'body')
  @ApiOperation({ summary: 'Relevant documents for a draft — hybrid search, no LLM required' })
  related(@Body() dto: AssistantRelatedDto) {
    return this.assistant.related(dto);
  }

  // -------------------------------------------------------------------------
  // Chat pane: persisted multi-turn threads. Live progress publishes on the
  // existing GET /v1/events SSE stream (KnowledgeEvent.subjectId = threadId).
  // -------------------------------------------------------------------------

  @Post('threads')
  @Access('viewer', 'body')
  @ApiOperation({ summary: 'Start a new chat pane thread, optionally pinned to a document' })
  createThread(@Body() dto: CreateAssistantThreadDto, @CurrentPrincipal() principal: Principal) {
    return this.threads.createThread(dto.workspaceId, principal.userId, dto);
  }

  @Get('threads')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'List chat pane threads for a workspace, most recently active first' })
  @ApiQuery({ name: 'workspaceId', required: true })
  listThreads(@Query('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.threads.listThreads(workspaceId);
  }

  @Get('threads/:id')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'A thread with its full message history' })
  @ApiQuery({ name: 'workspaceId', required: true, description: 'Unused by the lookup; required for the ACL check' })
  getThread(@Param('id', ParseUUIDPipe) id: string) {
    return this.threads.getThread(id);
  }

  @Post('threads/:id/messages')
  @Access('viewer', 'query')
  @ApiQuery({ name: 'workspaceId', required: true, description: 'Unused by the lookup; required for the ACL check' })
  @ApiOperation({
    summary:
      'Post a chat message — runs the tool harness (read + write tools) and returns the assistant reply; ' +
      'writes always go through create_document (new page) or propose_update (merge request), never directly',
  })
  postMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PostAssistantMessageDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.assistant.postMessage(id, dto, principal);
  }
}
