import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MemoryAccessService } from './memory-access.service.js';
import { MemoryBanksService } from './memory-banks.service.js';

/**
 * Memory banks (#986), the controller-free half: the request resolver and the
 * services behind the Hindsight-shaped routes. Loadable by every process.
 */
@Module({
  imports: [PrismaModule, AuthCoreModule, PermissionsCoreModule],
  providers: [MemoryAccessService, MemoryBanksService],
  exports: [MemoryAccessService, MemoryBanksService],
})
export class MemoryCoreModule {}
