import { Module } from '@nestjs/common';
import { GraphModule } from '../graph/graph.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ComponentUsagesService } from './component-usages.service.js';
import { ComponentsService } from './components.service.js';

/**
 * Component declarations and their derived `code` edges (#236), with no
 * controller, so the worker can import it: ingestion records declarations and
 * the codebase pull rebuilds the edges, both worker-side. The usages read
 * lives here too, so the MCP tool and the drift check (phase 4) can inject it.
 */
@Module({
  imports: [PrismaModule, GraphModule, PermissionsCoreModule],
  providers: [ComponentsService, ComponentUsagesService],
  exports: [ComponentsService, ComponentUsagesService],
})
export class ComponentsCoreModule {}
