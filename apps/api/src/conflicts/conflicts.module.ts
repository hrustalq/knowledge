import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { ConflictsController } from './conflicts.controller.js';
import { ConflictsCoreModule } from './conflicts-core.module.js';

/** Contradictions over HTTP (#81). API-only: the controller, and Propose through the findings service. */
@Module({
  imports: [ConflictsCoreModule, PermissionsCoreModule, AiModule],
  controllers: [ConflictsController],
})
export class ConflictsModule {}
