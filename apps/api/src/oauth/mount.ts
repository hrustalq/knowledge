import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { TooManyRequestsError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { oauthEnabled, oauthUrls } from '../auth/oauth-urls.js';
import { clientIp } from '../common/client-ip.js';
import { PublicRateLimiter } from '../public/public-rate-limit.js';
import { OAuthService } from './oauth.service.js';

/**
 * Budgets per IP, counted in the house Redis window rather than the SDK's
 * in-memory one (which forgets on restart and is per replica). Registration is
 * an anonymous write, so it fails closed when Redis is down; the rest stays up,
 * or a Redis blip would end every connected client's next refresh.
 */
const BUDGETS = {
  register: { limit: 20, windowMs: 3_600_000, failOpen: false },
  authorize: { limit: 60, windowMs: 600_000, failOpen: true },
  token: { limit: 120, windowMs: 600_000, failOpen: true },
  revoke: { limit: 60, windowMs: 600_000, failOpen: true },
} as const;

/**
 * Mounts OAuth for MCP (#1352) on the Express instance, ahead of Nest's
 * router: the MCP SDK's own handlers for authorize, token, registration and
 * revocation, and the two discovery documents. Nothing is mounted while
 * MCP_OAUTH_ENABLED is off, so every path 404s.
 */
export function mountOAuth(app: NestExpressApplication): void {
  const config = app.get(ConfigService);
  if (!oauthEnabled(config)) return;
  const provider = app.get(OAuthService);
  const limiter = app.get(PublicRateLimiter);
  const urls = oauthUrls(config);
  const limit = (bucket: keyof typeof BUDGETS) => async (req: Request, res: Response, next: NextFunction) => {
    const { limit: max, windowMs, failOpen } = BUDGETS[bucket];
    if (await limiter.hit(`oauth-${bucket}:${clientIp(req)}`, max, windowMs, failOpen)) return next();
    res.status(429).json(new TooManyRequestsError('Too many requests').toResponseObject());
  };

  const resourceMetadata = {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    // Claude asks for a refresh token only when this scope is offered.
    scopes_supported: ['offline_access'],
    bearer_methods_supported: ['header'],
    resource_name: 'Knowledge',
  };
  app.use(urls.resourceMetadataPath, metadataHandler(resourceMetadata));
  app.use('/.well-known/oauth-protected-resource', metadataHandler(resourceMetadata));
  app.use(
    '/.well-known/oauth-authorization-server',
    metadataHandler({
      issuer: urls.issuer,
      authorization_endpoint: urls.authorize,
      token_endpoint: urls.token,
      registration_endpoint: urls.register,
      revocation_endpoint: urls.revoke,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      // Public clients only; with this, Claude picks Client ID Metadata Documents over registration.
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      scopes_supported: ['offline_access'],
    }),
  );

  app.use('/oauth/authorize', limit('authorize'), authorizationHandler({ provider, rateLimit: false }));
  app.use('/oauth/token', limit('token'), tokenHandler({ provider, rateLimit: false }));
  app.use('/oauth/register', limit('register'), clientRegistrationHandler({ clientsStore: provider, rateLimit: false }));
  app.use('/oauth/revoke', limit('revoke'), revocationHandler({ provider, rateLimit: false }));
}
