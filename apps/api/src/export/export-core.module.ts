import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ExportQueueModule } from './export-queue.module.js';
import { ExportScopeService } from './export-scope.service.js';
import { ExportService } from './export.service.js';

/**
 * Exports (docs/features/45), controller-free: the REST routes in ExportModule
 * and the MCP tools both ask through ExportService. ExportScopeService is
 * exported for the worker, which resolves the scope again when a job runs.
 */
@Module({
  // PermissionsCoreModule: an export holds what its requester may open (#76).
  imports: [PrismaModule, AuthCoreModule, PermissionsCoreModule, StorageModule, ExportQueueModule],
  providers: [ExportService, ExportScopeService],
  exports: [ExportService, ExportScopeService],
})
export class ExportCoreModule {}
