import { Module } from '@nestjs/common';
import { GraphModule } from '../graph/graph.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { AdminConfigController } from './admin-config.controller.js';
import { AdminErrorsController } from './admin-errors.controller.js';
import { AdminErrorsService } from './admin-errors.service.js';
import { AdminHealthController } from './admin-health.controller.js';
import { AdminHealthService } from './admin-health.service.js';

/** The platform admin console's routes (#1235): API-only, every one @PlatformAdmin(). */
@Module({
  imports: [RedisModule, StorageModule, GraphModule],
  controllers: [AdminConfigController, AdminHealthController, AdminErrorsController],
  providers: [AdminHealthService, AdminErrorsService],
})
export class AdminModule {}
