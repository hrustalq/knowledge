import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SearchCoreModule } from '../search/search-core.module.js';
import { DocumentsCoreModule } from '../documents/documents-core.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { AssistantReadToolsService } from './assistant-read-tools.service.js';

/**
 * The read half of the tool surface, loadable from either process.
 *
 * Every import here is a controller-free Core module, which is the whole point:
 * AssistantModule pulls DocumentsModule and a controller, so the worker could
 * never load it, and that is why background agents had no tool loop and the
 * cartographer answered from a single pre-baked prompt.
 *
 * Nothing reachable from here can write. Keep it that way — a background agent
 * proposes and the API publishes (docs/features/17).
 */
@Module({
  imports: [PrismaModule, SearchCoreModule, DocumentsCoreModule, AuthCoreModule],
  providers: [AssistantReadToolsService],
  exports: [AssistantReadToolsService],
})
export class AssistantReadToolsModule {}
