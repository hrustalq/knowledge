import { Module } from '@nestjs/common';
import { ArcadeClient } from './arcade.client.js';
import { GraphService } from './graph.service.js';

@Module({
  providers: [ArcadeClient, GraphService],
  exports: [GraphService],
})
export class GraphModule {}
