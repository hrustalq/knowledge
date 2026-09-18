import { Module } from '@nestjs/common';
import { ArcadeClient } from './arcade.client.js';
import { EntityAliasService } from './entity-alias.service.js';
import { GraphService } from './graph.service.js';

@Module({
  // EntityAliasService lives here, not in EntitiesModule: that module carries a
  // controller and therefore AccessService, so it must never load in the worker
  // — and the worker is exactly where ingestion resolves entity keys.
  providers: [ArcadeClient, EntityAliasService, GraphService],
  exports: [EntityAliasService, GraphService],
})
export class GraphModule {}
