import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SearchService } from './search.service.js';
import { SearchDto } from './search.dto.js';

@ApiTags('search')
@Controller('v1/search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Semantic search over indexed chunks (hybrid graph expansion: Phase 2)' })
  run(@Body() dto: SearchDto) {
    return this.search.search(dto);
  }
}
