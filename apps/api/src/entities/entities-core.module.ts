import { Module } from '@nestjs/common';
import { GraphModule } from '../graph/graph.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { TemporalCoreModule } from '../temporal/temporal-core.module.js';
import { EntitiesService } from './entities.service.js';

/** EntitiesService without its controller (#636): the git process merges merge requests, whose breaking-API gate reads it. */
@Module({
  imports: [GraphModule, PermissionsCoreModule, TemporalCoreModule],
  providers: [EntitiesService],
  exports: [EntitiesService],
})
export class EntitiesCoreModule {}
