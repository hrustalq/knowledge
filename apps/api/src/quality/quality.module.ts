import { Module } from '@nestjs/common';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { QualityController } from './quality.controller.js';
import { QualityCoreModule } from './quality-core.module.js';

/** API side: the quality routes over QualityCoreModule. */
@Module({
  imports: [QualityCoreModule, PermissionsCoreModule],
  controllers: [QualityController],
})
export class QualityModule {}
