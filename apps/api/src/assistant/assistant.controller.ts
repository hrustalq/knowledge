import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Access } from '../auth/access.decorator.js';
import { AssistantService } from './assistant.service.js';
import { AssistantAskDto, AssistantRelatedDto, AssistantReviewDto, AssistantSuggestDto } from './assistant.dto.js';

@ApiTags('assistant')
@Controller('v1/assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

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
  @ApiOperation({ summary: 'Chat about a document — grounded in its content and related pages' })
  ask(@Body() dto: AssistantAskDto) {
    return this.assistant.ask(dto);
  }

  @Post('related')
  @Access('viewer', 'body')
  @ApiOperation({ summary: 'Relevant documents for a draft — hybrid search, no LLM required' })
  related(@Body() dto: AssistantRelatedDto) {
    return this.assistant.related(dto);
  }
}
