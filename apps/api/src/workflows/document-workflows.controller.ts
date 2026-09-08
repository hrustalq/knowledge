import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { DocumentWorkflowRunsResponse } from '@knowledge/contracts';
import { Access } from '../auth/access.decorator.js';
import { WorkflowsService } from './workflows.service.js';

/**
 * The document page's workflow rail (docs/features/17).
 *
 * A separate controller under the `v1/documents` prefix rather than a method on
 * `DocumentsController`: `WorkflowsModule` already imports `DocumentsModule` to
 * materialise drafts, so hanging this off the documents side would close the
 * loop into a circular dependency.
 */
@ApiTags('workflows')
@Controller('v1/documents')
export class DocumentWorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get(':id/workflow-runs')
  @Access('viewer', 'document')
  @ApiOperation({ summary: 'Runs rooted at this page, plus the workflows that may be started against it' })
  runsForDocument(@Param('id', ParseUUIDPipe) id: string): Promise<DocumentWorkflowRunsResponse> {
    return this.workflows.runsForDocument(id);
  }
}
