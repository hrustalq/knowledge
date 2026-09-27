import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Access } from '../auth/access.decorator.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { sendPageMarkdown } from './ai-readable.http.js';
import { AiReadableService } from './ai-readable.service.js';
import { wantsFrontmatter } from './render.js';

@ApiTags('documents')
@Controller('v1/documents')
export class AiReadableController {
  constructor(private readonly aiReadable: AiReadableService) {}

  @Get(':id/markdown')
  @Access('viewer', 'document')
  @ApiProduces('text/markdown')
  @ApiOperation({
    summary:
      'A page as plain markdown for agents and AI tools (issue #68). Head of the default branch by default; ' +
      'frontmatter=1 prepends the page YAML plus provenance under `knowledge:`. ETag / If-None-Match → 304',
  })
  @ApiQuery({ name: 'revision', required: false })
  @ApiQuery({ name: 'frontmatter', required: false, description: '1 to include the YAML block' })
  @ApiResponse({ status: 304, description: 'Unchanged since the ETag sent in If-None-Match' })
  async markdown(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('revision') revision?: string,
    @Query('frontmatter') frontmatter?: string,
  ): Promise<string | undefined> {
    this.aiReadable.assertEnabled();
    // Not @Headers(): it would publish If-None-Match as a required parameter.
    const result = await this.aiReadable.pageMarkdown(id, {
      revisionId: revision || undefined,
      frontmatter: wantsFrontmatter(frontmatter),
      ifNoneMatch: req.headers['if-none-match'],
    });
    return sendPageMarkdown(res, result);
  }
}
