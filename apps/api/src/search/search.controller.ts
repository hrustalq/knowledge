import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Access } from '../auth/access.decorator.js';
import { SearchService } from './search.service.js';
import { SearchDto } from './search.dto.js';

@ApiTags('search')
@Controller('v1/search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Post()
  @HttpCode(200)
  @Access('viewer', 'body')
  @ApiOperation({ summary: 'Search indexed chunks: semantic, keyword (BM25) or hybrid (RRF fusion + graph expansion)' })
  run(@Body() dto: SearchDto) {
    return this.search.search(dto);
  }
}
