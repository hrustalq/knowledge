import { Module } from '@nestjs/common';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { CommunitiesController } from './communities.controller.js';
import { CommunitiesCoreModule } from './communities-core.module.js';

/** Communities over HTTP (#81). API-only: the controller. */
@Module({
  imports: [CommunitiesCoreModule, PermissionsCoreModule],
  controllers: [CommunitiesController],
})
export class CommunitiesModule {}
