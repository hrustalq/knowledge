import { Module } from '@nestjs/common';
import { GraphModule } from '../graph/graph.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { TemporalCoreModule } from '../temporal/temporal-core.module.js';
import { EntitiesController } from './entities.controller.js';
import { EntitiesService } from './entities.service.js';

@Module({
  imports: [GraphModule, PermissionsCoreModule, TemporalCoreModule],
  controllers: [EntitiesController],
  providers: [EntitiesService],
  exports: [EntitiesService],
})
export class EntitiesModule {}
