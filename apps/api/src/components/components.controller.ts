import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ComponentDeclarationView } from '@knowledge/contracts';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { Access } from '../auth/access.decorator.js';
import { ComponentsService } from './components.service.js';

/**
 * A page's component declaration (#236). Mounted on `v1/documents` beside
 * `DocumentsController`; the route is `:id/<literal>`, so there is no ordering
 * hazard with its `@Get(':id')`.
 */
@ApiTags('documents')
@Controller('v1/documents')
export class ComponentsController {
  constructor(private readonly components: ComponentsService) {}

  @Get(':id/component')
  @Access('viewer', 'document')
  @ApiOperation({
    summary:
      'The code the page declares it documents (its `component:` frontmatter), as resolved to a codebase ' +
      'connector at its default-branch head; null when it declares none. `warning` says why a declaration ' +
      'resolved to no connector',
  })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ComponentDeclarationView | null> {
    return this.components.view(id);
  }
}
