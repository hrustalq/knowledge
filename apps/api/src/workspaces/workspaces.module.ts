import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspacesService } from './workspaces.service.js';
import { WorkspaceTeardownService } from './workspace-teardown.service.js';
import { WorkspaceTeardownSweeper } from './workspace-teardown.sweeper.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { FulltextModule } from '../fulltext/fulltext.module.js';

/**
 * Access-control management (workspaces + members) and workspace deletion
 * (#479). API-only module — keep it out of worker and MCP contexts (same
 * rationale as GraphQueryModule); the teardown sweeper must run where storage,
 * the graph and BM25 may be deleted from.
 */
@Module({
  imports: [PrismaModule, AuthCoreModule, ProjectsModule, StorageModule, GraphModule, FulltextModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, WorkspaceTeardownService, WorkspaceTeardownSweeper],
})
export class WorkspacesModule {}
