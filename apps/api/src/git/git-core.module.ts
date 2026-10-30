import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ProjectCommitsService } from './project-commits.service.js';

/** Stored project commits (#636): controller-free, loaded wherever a page changes. */
@Module({
  imports: [PrismaModule],
  providers: [ProjectCommitsService],
  exports: [ProjectCommitsService],
})
export class GitCoreModule {}
