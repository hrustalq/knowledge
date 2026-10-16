import { Module } from '@nestjs/common';
import { ComponentsCoreModule } from './components-core.module.js';
import { ComponentsController } from './components.controller.js';

/** The REST surface for component declarations (#236). API-only: it carries a controller. */
@Module({
  imports: [ComponentsCoreModule],
  controllers: [ComponentsController],
  exports: [ComponentsCoreModule],
})
export class ComponentsModule {}
