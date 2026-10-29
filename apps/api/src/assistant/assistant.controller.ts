import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  errorCodeForStatus,
  type ApiErrorPayload,
  type AssistantLintResponse,
  type AssistantStreamFrame,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal, Feature } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { AssistantService } from './assistant.service.js';
import { AssistantThreadsService } from './assistant-threads.service.js';
import { StyleLintService } from './style-lint.service.js';
import {
  AssistantAskDto,
  AssistantLintDto,
  AssistantRelatedDto,
  AssistantReviewDto,
  AssistantSuggestDto,
  CreateAssistantThreadDto,
  ListAssistantThreadsQueryDto,
  PostAssistantMessageDto,
  UpdateAssistantThreadDto,
} from './assistant.dto.js';
import { Returns } from '../common/returns.decorator.js';
import type {
  AssistantAskResponse,
  AssistantRelatedResponse,
  AssistantReviewResponse,
  AssistantSuggestResponse,
  CreateAssistantThreadResponse,
  DeleteAssistantThreadResponse,
  GetAssistantThreadResponse,
  ListAssistantThreadsResponse,
  PostAssistantMessageResponse,
  TruncateAssistantThreadResponse,
  UpdateAssistantThreadResponse,
} from '@knowledge/contracts';

@ApiTags('assistant')
@Controller('v1/assistant')
export class AssistantController {
  private readonly logger = new Logger(AssistantController.name);

  constructor(
    private readonly assistant: AssistantService,
    private readonly threads: AssistantThreadsService,
    private readonly styleLint: StyleLintService,
  ) {}

  @Post('review')
  @Returns('AssistantReviewResponse')
  @Access('viewer', 'body')
  @ApiOperation({ summary: 'LLM review of a draft (docs/features/09); enabled=false when the provider is none' })
  review(@Body() dto: AssistantReviewDto, @CurrentPrincipal() principal: Principal): Promise<AssistantReviewResponse> {
    return this.assistant.review(dto, principal);
  }

  @Post('lint')
  @Returns('AssistantLintResponse')
  @Access('viewer', 'body')
  @ApiOperation({
    summary:
      'Check text against the styleguide that applies to its project (#74). Each violation cites a rule id of ' +
      'that styleguide and quotes the text verbatim; anything else the model reports is dropped and counted.',
  })
  lint(@Body() dto: AssistantLintDto, @CurrentPrincipal() principal: Principal): Promise<AssistantLintResponse> {
    return this.styleLint.lint(dto, principal);
  }

  @Post('suggest')
  @Returns('AssistantSuggestResponse')
  @Access('viewer', 'body')
  @ApiOperation({ summary: 'LLM writing suggestion for a draft (outline / continuation / rewrite)' })
  suggest(@Body() dto: AssistantSuggestDto, @CurrentPrincipal() principal: Principal): Promise<AssistantSuggestResponse> {
    return this.assistant.suggest(dto, principal);
  }

  @Post('ask')
  @Returns('AssistantAskResponse')
  @Access('viewer', 'body')
  @ApiOperation({
    summary:
      'Chat about a document — tool-calling harness (search/read/graph), every tool call authorized against the caller session',
  })
  ask(@Body() dto: AssistantAskDto, @CurrentPrincipal() principal: Principal): Promise<AssistantAskResponse> {
    return this.assistant.ask(dto, principal);
  }

  @Post('related')
  @Returns('AssistantRelatedResponse')
  @Access('viewer', 'body')
  @ApiOperation({ summary: 'Relevant documents for a draft — hybrid search, no LLM required' })
  related(@Body() dto: AssistantRelatedDto, @CurrentPrincipal() principal: Principal): Promise<AssistantRelatedResponse> {
    return this.assistant.related(dto, principal);
  }

  // -------------------------------------------------------------------------
  // Chat pane: persisted multi-turn threads. Live progress publishes on the
  // existing GET /v1/events SSE stream (KnowledgeEvent.subjectId = threadId).
  // -------------------------------------------------------------------------

  @Post('threads')
  @Feature('assistant')
  @Returns('CreateAssistantThreadResponse')
  @Access('viewer', 'body')
  @ApiOperation({ summary: 'Start a new chat pane thread, optionally pinned to a document' })
  createThread(@Body() dto: CreateAssistantThreadDto, @CurrentPrincipal() principal: Principal): Promise<CreateAssistantThreadResponse> {
    return this.threads.createThread(dto.workspaceId, principal.userId, dto);
  }

  @Get('threads')
  @Feature('assistant')
  @Returns('ListAssistantThreadsResponse')
  @Access('viewer', 'query')
  @ApiOperation({
    summary: 'List chat pane threads for a workspace, most recently active first (search + keyset pagination)',
  })
  listThreads(@Query() query: ListAssistantThreadsQueryDto): Promise<ListAssistantThreadsResponse> {
    return this.threads.listThreads(query.workspaceId, query);
  }

  // The routes below resolve their workspace from the thread id itself, so a
  // caller cannot pair a thread from one tenant with a workspaceId they happen
  // to be a member of and have the ACL pass.

  @Get('threads/:id')
  @Feature('assistant')
  @Returns('GetAssistantThreadResponse')
  @Access('viewer', 'assistant-thread')
  @ApiOperation({ summary: 'A thread with its full message history, each reply carrying your own vote on it' })
  getThread(@Param('id', ParseUUIDPipe) id: string, @CurrentPrincipal() principal: Principal): Promise<GetAssistantThreadResponse> {
    return this.threads.getThread(id, principal.userId);
  }

  @Patch('threads/:id')
  @Feature('assistant')
  @Returns('UpdateAssistantThreadResponse')
  @Access('viewer', 'assistant-thread')
  @ApiOperation({ summary: 'Rename a chat thread (null title restores the auto-derived one)' })
  updateThread(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAssistantThreadDto): Promise<UpdateAssistantThreadResponse> {
    return this.threads.updateThread(id, dto);
  }

  @Delete('threads/:id')
  @Feature('assistant')
  @Returns('DeleteAssistantThreadResponse')
  @Access('viewer', 'assistant-thread')
  @ApiOperation({ summary: 'Delete a chat thread and its whole message history' })
  deleteThread(@Param('id', ParseUUIDPipe) id: string): Promise<DeleteAssistantThreadResponse> {
    return this.threads.deleteThread(id);
  }

  /**
   * Rewind. Reach is deliberately the same as deleting the whole thread above:
   * truncating one cannot need more than removing all of it.
   */
  @Delete('threads/:id/messages/:messageId')
  @Feature('assistant')
  @Returns('TruncateAssistantThreadResponse')
  @Access('viewer', 'assistant-thread')
  @ApiOperation({
    summary: 'Rewind a chat thread — deletes this message and every message after it, and returns what survives',
  })
  truncateThread(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<TruncateAssistantThreadResponse> {
    return this.threads.truncateFrom(id, messageId);
  }

  @Post('threads/:id/messages')
  @Feature('assistant')
  @Returns('PostAssistantMessageResponse')
  @Access('viewer', 'assistant-thread')
  @ApiOperation({
    summary:
      'Post a chat message — runs the tool harness (read + write tools) and returns the assistant reply; ' +
      'writes always go through create_document (new page) or propose_update (merge request), never directly',
  })
  postMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PostAssistantMessageDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PostAssistantMessageResponse> {
    return this.assistant.postMessage(id, dto, principal);
  }

  /**
   * The same turn as POST .../messages, streamed as it happens.
   *
   * Hand-written SSE rather than Nest's `@Sse()`, which only decorates GET —
   * and this has to be a POST, because the turn carries a body (attachments,
   * applied documents, mode). That also means the client reads it with fetch
   * instead of EventSource, so the normal Authorization header applies and
   * there is no `?token=` in a URL.
   */
  @Post('threads/:id/messages/stream')
  @Feature('assistant')
  @Access('viewer', 'assistant-thread')
  @ApiOperation({
    summary: 'Streamed chat turn (text/event-stream of AssistantStreamFrame) — same turn as POST .../messages',
  })
  @ApiProduces('text/event-stream')
  async streamMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PostAssistantMessageDto,
    @CurrentPrincipal() principal: Principal,
    @Res() res: Response,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx and friends buffer unknown streams into uselessness.
      'X-Accel-Buffering': 'no',
    });

    // The client hanging up mid-turn — Stop, navigation, a closed tab — is
    // the cancel signal. It has to reach the harness rather than just stop
    // the writing: the model's tools can publish pages and open merge
    // requests, so a "stop" that only muted the output would still let the
    // turn act on the workspace after the user asked it not to.
    let open = true;
    const cancel = new AbortController();
    res.on('close', () => {
      open = false;
      cancel.abort();
    });
    const emit = (frame: AssistantStreamFrame): void => {
      if (open) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };

    try {
      await this.assistant.streamMessage(id, dto, principal, emit, cancel.signal);
    } catch (err) {
      this.logger.warn(`Assistant stream failed: ${err instanceof Error ? err.message : String(err)}`);
      emit({ type: 'error', error: streamErrorPayload(err, `/v1/assistant/threads/${id}/messages/stream`) });
    } finally {
      if (open) res.end();
    }
  }
}

/**
 * The strict error envelope, produced by hand. ApiExceptionFilter cannot help
 * here: the response is already committed with a 200 and streaming headers by
 * the time anything can fail, so the failure has to travel inside the stream.
 */
function streamErrorPayload(err: unknown, path: string): ApiErrorPayload {
  const status = err instanceof HttpException ? err.getStatus() : 500;
  const message =
    err instanceof HttpException
      ? err.message
      : 'The assistant turn failed. Reopen the chat to see whether any of it was saved.';
  // Flat extras ride in `details`, as ApiExceptionFilter hoists them — the pane
  // branches on a 409's `reason` (`flow-answer-stale`, #425).
  const body = err instanceof HttpException ? err.getResponse() : null;
  const { statusCode: _s, error: _e, message: _m, code: _c, ...extras } =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  return {
    statusCode: status,
    code: errorCodeForStatus(status),
    message,
    ...(Object.keys(extras).length > 0 ? { details: extras } : {}),
    path,
    timestamp: new Date().toISOString(),
    requestId: '',
  };
}
