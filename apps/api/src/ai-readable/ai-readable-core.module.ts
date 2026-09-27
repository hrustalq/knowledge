import { Module } from '@nestjs/common';
import { DocumentsCoreModule } from '../documents/documents-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { AiReadableService } from './ai-readable.service.js';

/**
 * AI-readable output without controllers (issue #68). DocumentsModule imports
 * it for `Accept: text/markdown` on `/content`; the MCP server will import it
 * for resource templates. Never reaches for AccessService.
 */
@Module({
  imports: [PrismaModule, StorageModule, DocumentsCoreModule],
  providers: [AiReadableService],
  exports: [AiReadableService],
})
export class AiReadableCoreModule {}
