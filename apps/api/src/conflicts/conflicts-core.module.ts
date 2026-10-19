import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ConflictsService } from './conflicts.service.js';

/** Contradictions between pages (#81). Controller-free: the worker records, the API reads. */
@Module({
  imports: [PrismaModule, EventsModule],
  providers: [ConflictsService],
  exports: [ConflictsService],
})
export class ConflictsCoreModule {}
