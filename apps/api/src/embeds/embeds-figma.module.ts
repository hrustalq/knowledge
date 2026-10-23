import { Module } from '@nestjs/common';
import { ConnectorsCoreModule } from '../connectors/connectors-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { FigmaFilesService } from './figma-files.service.js';

/**
 * The Figma side of embeds (#470): the allowlist's files and the calls the
 * picker and the renderer make. Controller-free, so the worker (renders) and
 * the API (the picker) share one reading of the allowlist.
 */
@Module({
  imports: [PrismaModule, ConnectorsCoreModule],
  providers: [FigmaFilesService],
  exports: [FigmaFilesService],
})
export class EmbedsFigmaModule {}
