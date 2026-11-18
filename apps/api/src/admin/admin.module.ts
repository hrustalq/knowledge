import { Module } from '@nestjs/common';
import { AdminConfigController } from './admin-config.controller.js';

/** The platform admin console's routes (#1235): API-only, every one @PlatformAdmin(). */
@Module({ controllers: [AdminConfigController] })
export class AdminModule {}
