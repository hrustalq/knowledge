import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { WorkflowCoreModule } from './workflow-core.module.js';
import { WorkflowsModule } from './workflows.module.js';
import { WorkflowMaterializeSweeper } from './workflow-materialize.sweeper.js';

/**
 * The materialize sweeper, on its own so only the API process runs it.
 *
 * It used to sit in `WorkflowsModule`'s providers, which was fine while that
 * module really was API-only. `McpModule` then imported `WorkflowsModule` for
 * its three workflow tools — a legitimate need, since MCP does list and start
 * runs — and inherited a 5-second timer writing pages from every stdio process
 * an agent client happened to spawn.
 *
 * Splitting rather than dropping the import is what keeps both true: MCP gets
 * `WorkflowsService`, and materialisation stays where documents are meant to be
 * written. Imported by `AppModule` alone.
 */
@Module({
  imports: [PrismaModule, WorkflowsModule, WorkflowCoreModule],
  providers: [WorkflowMaterializeSweeper],
})
export class WorkflowMaterializeModule {}
