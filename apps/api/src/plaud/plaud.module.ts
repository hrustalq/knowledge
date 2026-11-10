import { Module } from '@nestjs/common';
import { PlaudCoreModule } from './plaud-core.module.js';
import { PlaudController } from './plaud.controller.js';

/** Plaud (#864), API side. Controller-bearing, so never imported by the worker. */
@Module({
  imports: [PlaudCoreModule],
  controllers: [PlaudController],
})
export class PlaudModule {}
