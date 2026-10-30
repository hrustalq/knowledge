import { Module } from '@nestjs/common';
import { GraphModule } from '../graph/graph.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { TemporalCoreModule } from '../temporal/temporal-core.module.js';
import { EntitiesController } from './entities.controller.js';
import { EntitiesCoreModule } from './entities-core.module.js';

@Module({
  imports: [EntitiesCoreModule, GraphModule, PermissionsCoreModule, TemporalCoreModule],
  controllers: [EntitiesController],
  exports: [EntitiesCoreModule],
})
export class EntitiesModule {}
