import { Module } from '@nestjs/common';
import { GraphModule } from '../graph/graph.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ReleaseTagsService } from './release-tags.service.js';
import { TemporalResolverService } from './temporal-resolver.service.js';

/** The bi-temporal graph's services (#81): controller-free, so the MCP server loads it too. */
@Module({
  imports: [PrismaModule, GraphModule, PermissionsCoreModule],
  providers: [TemporalResolverService, ReleaseTagsService],
  exports: [TemporalResolverService, ReleaseTagsService],
})
export class TemporalCoreModule {}
