import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BUILT_IN_BLUEPRINT_KEYS, type ListBlueprintsResponse } from '@knowledge/contracts';
import { Access } from '../auth/access.decorator.js';
import { Returns } from '../common/returns.decorator.js';
import { WorkspaceQueryDto } from '../templates/templates.dto.js';
import { BUILT_IN_BLUEPRINTS } from './built-in/index.js';

/**
 * The blueprints a project can start from (#716): the wizard's Start step and
 * the tree it seeds Shape with. Built-ins only until saved blueprints land;
 * both languages travel, because the skeleton language is picked last.
 */
@ApiTags('projects')
@Controller('v1/blueprints')
export class BlueprintsController {
  @Get()
  @Returns('ListBlueprintsResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Blueprints a project can be scaffolded from (built-ins, in both languages)' })
  list(@Query() _query: WorkspaceQueryDto): ListBlueprintsResponse {
    return { blueprints: BUILT_IN_BLUEPRINT_KEYS.map((key) => ({ key, blueprint: BUILT_IN_BLUEPRINTS[key] })) };
  }
}
