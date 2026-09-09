import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ProfilesController } from './profiles.controller.js';
import { ProfilesService } from './profiles.service.js';

/**
 * API-only (same rationale as UsersModule/WorkspacesModule): the controller
 * needs AccessService from the global AuthModule, which the worker and MCP
 * contexts do not load.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ProfilesController],
  providers: [ProfilesService],
})
export class ProfilesModule {}
