import { Module } from '@nestjs/common';
import { GraphModule } from './graph.module.js';
import { GraphQueryController } from './graph-query.controller.js';

/**
 * HTTP surface for operator graph queries. Separate from GraphModule so the
 * worker/MCP contexts (which import GraphModule) never instantiate the
 * controller and its auth dependencies.
 */
@Module({
  imports: [GraphModule],
  controllers: [GraphQueryController],
})
export class GraphQueryModule {}
