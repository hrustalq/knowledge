import { Module } from '@nestjs/common';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { ReleaseTagsController } from './release-tags.controller.js';
import { TemporalCoreModule } from './temporal-core.module.js';

/** Release tags and the graph timeline over HTTP (#81). API-only: the controller. */
@Module({
  imports: [TemporalCoreModule, PermissionsCoreModule],
  controllers: [ReleaseTagsController],
})
export class TemporalModule {}
