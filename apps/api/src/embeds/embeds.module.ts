import { Module } from '@nestjs/common';
import { EmbedsCoreModule } from './embeds-core.module.js';
import { EmbedsController } from './embeds.controller.js';
import { EmbedsFigmaModule } from './embeds-figma.module.js';
import { FigmaPickerController } from './figma-picker.controller.js';
import { EmbedUsagesController } from './embed-usages.controller.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';

/** API side of embeds: the status and snapshot routes, and the editor's Figma picker. */
@Module({
  imports: [EmbedsCoreModule, EmbedsFigmaModule, PermissionsCoreModule],
  controllers: [EmbedsController, FigmaPickerController, EmbedUsagesController],
})
export class EmbedsModule {}
