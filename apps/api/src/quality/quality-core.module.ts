import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { QualityService } from './quality.service.js';

/**
 * The quality score reads (#74, phase 5), controller-free and auth-free so the
 * MCP tool set can load them (`knowledge_get_page_quality`). The scores
 * themselves are written by the worker's auditor (AgentExecutor `audit()`).
 */
@Module({
  imports: [PrismaModule, AiCoreModule],
  providers: [QualityService],
  exports: [QualityService],
})
export class QualityCoreModule {}
