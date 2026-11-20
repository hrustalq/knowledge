import { Module } from '@nestjs/common';
import { OAuthController } from './oauth.controller.js';
import { OAuthService } from './oauth.service.js';

/**
 * OAuth for MCP clients (#1352, docs/features/33). API-only: the consent
 * routes need a session, and `main.ts` mounts the protocol endpoints on this
 * process's Express instance (`mount.ts`). AuthModule is global and gives the
 * rest (keys, access, audit, the rate limiter).
 */
@Module({
  controllers: [OAuthController],
  providers: [OAuthService],
})
export class OAuthModule {}
