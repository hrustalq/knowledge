import { Module } from '@nestjs/common';
import { EmbedsCoreModule } from './embeds-core.module.js';
import { EmbedsController } from './embeds.controller.js';
import { ConnectorsCoreModule } from '../connectors/connectors-core.module.js';
import { FigmaPickerController } from './figma-picker.controller.js';
import { EmbedUsagesController } from './embed-usages.controller.js';
import { FigmaOauthController } from './figma-oauth.controller.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';

/** API side of embeds: the status and snapshot routes, the editor's Figma picker, and Connect with Figma. */
@Module({
  imports: [EmbedsCoreModule, ConnectorsCoreModule, PermissionsCoreModule],
  controllers: [EmbedsController, FigmaPickerController, EmbedUsagesController, FigmaOauthController],
})
export class EmbedsModule {}
