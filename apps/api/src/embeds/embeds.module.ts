import { Module } from '@nestjs/common';
import { EmbedsCoreModule } from './embeds-core.module.js';
import { EmbedsController } from './embeds.controller.js';

/** API side of embeds: the status and snapshot routes. */
@Module({
  imports: [EmbedsCoreModule],
  controllers: [EmbedsController],
})
export class EmbedsModule {}
