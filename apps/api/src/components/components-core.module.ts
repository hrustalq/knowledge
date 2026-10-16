import { Module } from '@nestjs/common';
import { GraphModule } from '../graph/graph.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ComponentsService } from './components.service.js';

/**
 * Component declarations and their derived `code` edges (#236), with no
 * controller, so the worker can import it: ingestion records declarations and
 * the codebase pull rebuilds the edges, both worker-side.
 */
@Module({
  imports: [PrismaModule, GraphModule],
  providers: [ComponentsService],
  exports: [ComponentsService],
})
export class ComponentsCoreModule {}
