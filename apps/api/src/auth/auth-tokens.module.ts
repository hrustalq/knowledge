import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SessionsService } from './sessions.service.js';
import { TokenAuthService } from './token-auth.service.js';
import { UrlTicketsService } from './url-tickets.service.js';

/**
 * Credential → principal, without the guards and controllers `AuthModule`
 * registers (#636). The git process authenticates a `kn_` key with the very
 * resolver the HTTP guard uses, and must not load those controllers.
 * `AuthModule` re-exports it, so nothing that already injected these changes.
 */
@Module({
  imports: [PrismaModule],
  providers: [SessionsService, TokenAuthService, UrlTicketsService],
  exports: [SessionsService, TokenAuthService, UrlTicketsService],
})
export class AuthTokensModule {}
