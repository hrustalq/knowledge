import { Module } from '@nestjs/common';
import { BootstrapModule } from '../config/bootstrap.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { AuthTokensModule } from '../auth/auth-tokens.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { PublicStore } from '../public/public-store.js';
import { PublicRateLimiter } from '../public/public-rate-limit.js';
import { GitAccessService } from './git-access.service.js';
import { GitController } from './git.controller.js';
import { GitRepoService } from './git-repo.service.js';

/**
 * Root module of the sixth entrypoint, `git.main.ts` (#636): a project as a
 * git remote over smart HTTP. Its own HTTP process, so packs never pass
 * through the API and a cold build never competes with API requests.
 *
 * It loads controller-free core modules only, plus its one controller —
 * `apps/api/.dependency-cruiser.cjs` holds it to that — and authenticates in
 * `GitAccessService` rather than through `AuthModule`'s global guards.
 */
@Module({
  imports: [BootstrapModule, PrismaModule, AuthCoreModule, AuthTokensModule, PermissionsCoreModule, StorageModule],
  controllers: [GitController],
  providers: [GitAccessService, GitRepoService, PublicStore, PublicRateLimiter],
})
export class GitModule {}
