import type { ConfigService } from '@nestjs/config';

/**
 * Where OAuth for MCP lives (#1352), from API_PUBLIC_URL alone. The issuer is
 * that URL's origin, so every discovery document sits at the origin root
 * (`/.well-known/oauth-*`): RFC 8414 and RFC 9728 put a path issuer's metadata
 * there anyway, and a 2025-03-26 client that skips resource metadata looks for
 * it at the MCP server's origin. In production the API is under `/api`, so the
 * proxy sends those two paths to it unstripped; endpoints keep the `/api`.
 */
export function oauthUrls(config: ConfigService) {
  const api = String(config.get('API_PUBLIC_URL')).replace(/\/+$/, '');
  const issuer = new URL(api).origin;
  const resource = `${api}/v1/mcp`;
  const resourcePath = new URL(resource).pathname;
  return {
    issuer,
    resource,
    /** Path on this API process, as the proxy forwards it. */
    resourceMetadataPath: `/.well-known/oauth-protected-resource${resourcePath}`,
    resourceMetadata: `${issuer}/.well-known/oauth-protected-resource${resourcePath}`,
    authorize: `${api}/oauth/authorize`,
    token: `${api}/oauth/token`,
    register: `${api}/oauth/register`,
    revoke: `${api}/oauth/revoke`,
    consent: `${String(config.get('WEB_BASE_URL')).replace(/\/+$/, '')}/oauth/authorize`,
  };
}

export function oauthEnabled(config: ConfigService): boolean {
  return config.get('MCP_OAUTH_ENABLED') === true && config.get('AUTH_MODE') === 'api-key';
}
