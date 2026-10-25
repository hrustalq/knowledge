import { Body, Controller, Delete, Param, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { DeleteAnswerFeedbackResponse, SetAnswerFeedbackResponse } from '@knowledge/contracts';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { Access, CurrentPrincipal } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { AnswerFeedbackService } from './answer-feedback.service.js';
import { AskFeedbackDto, SetMessageFeedbackDto } from './answer-feedback.dto.js';
import { Returns } from '../common/returns.decorator.js';

/**
 * Votes on answers (docs/features/38, issue #67 phase 2).
 *
 * Same `v1/assistant` prefix as the chat routes, in its own controller so the
 * feedback area owns it. `@Access('viewer', …)` is what admits a read-only API
 * key here despite the PUT/DELETE: `requireRole` narrows a key by role, not by
 * method, and a viewer may rate what a viewer may read — no `@ReadKeyOk` is
 * needed, that escape is for routes with no workspace to check a role in.
 */
@ApiTags('assistant')
@Controller('v1/assistant')
export class AnswerFeedbackController {
  constructor(private readonly feedback: AnswerFeedbackService) {}

  // The workspace is resolved from the message's own thread, so a message from
  // another tenant 403s before the handler runs.

  @Put('messages/:id/feedback')
  @Returns('SetAnswerFeedbackResponse')
  @Access('viewer', 'assistant-message')
  @ApiOperation({ summary: 'Rate an assistant reply (thumbs up/down with a reason); re-voting replaces the vote' })
  async vote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetMessageFeedbackDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SetAnswerFeedbackResponse> {
    return { feedback: await this.feedback.vote(id, principal, dto) };
  }

  @Delete('messages/:id/feedback')
  @Returns('DeleteAnswerFeedbackResponse')
  @Access('viewer', 'assistant-message')
  @ApiOperation({ summary: 'Retract your own vote on an assistant reply' })
  async retract(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DeleteAnswerFeedbackResponse> {
    const { removed } = await this.feedback.retract(id, principal);
    return { ok: true, removed };
  }

  @Post('ask/feedback')
  @Returns('SetAnswerFeedbackResponse')
  @Access('viewer', 'body')
  @ApiOperation({ summary: 'Rate a one-shot POST /v1/assistant/ask answer — the client sends what it saw' })
  async voteOnAsk(
    @Body() dto: AskFeedbackDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SetAnswerFeedbackResponse> {
    return { feedback: await this.feedback.voteOnAsk(dto, principal) };
  }
}
