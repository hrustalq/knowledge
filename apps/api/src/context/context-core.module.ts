import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SearchCoreModule } from '../search/search-core.module.js';
import { MemoryCoreModule } from '../memory/memory-core.module.js';
import { AnalyticsCoreModule } from '../analytics/analytics-core.module.js';
import { ContextService } from './context.service.js';

/** Ticket context (#1193) with no controller: the MCP server and the REST route share it. */
@Module({
  imports: [PrismaModule, SearchCoreModule, MemoryCoreModule, AnalyticsCoreModule],
  providers: [ContextService],
  exports: [ContextService],
})
export class ContextCoreModule {}
