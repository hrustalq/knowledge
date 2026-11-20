import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
  TemporarilyUnavailableError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  OAuthClientMetadataSchema,
  type OAuthClientInformationFull,
  type OAuthTokenRevocationRequest,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClient } from '@prisma/client';
import { OAUTH_GRANT_DEFAULT_DAYS, type OAuthDecisionResponse, type OAuthRequestView } from '@knowledge/contracts';
import { AccessService } from '../auth/access.service.js';
import { ApiKeysService } from '../auth/api-keys.service.js';
import type { CreateApiKeyDto } from '../auth/api-keys.dto.js';
import type { Principal } from '../auth/principal.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../auth/audit.service.js';
import { hashToken, mintToken } from '../auth/auth-tokens.js';
import { OAUTH_ACCESS_PREFIX, OAUTH_REFRESH_PREFIX } from '../auth/token-auth.service.js';
import { oauthEnabled, oauthUrls } from '../auth/oauth-urls.js';
import { safeFetch } from '../common/safe-fetch.js';

const MINUTE = 60_000;
const ACCESS_TTL_MS = 60 * MINUTE;
/** Long enough to sign in and read the consent screen. */
const REQUEST_TTL_MS = 10 * MINUTE;
/** The code itself, once approved: the client redeems it at once. */
const CODE_TTL_MS = 2 * MINUTE;
/** Never-granted registrations are a table anyone can write to: kept a day, at most this many. */
const DCR_UNGRANTED_TTL_MS = 24 * 60 * MINUTE;
const DCR_UNGRANTED_CAP = 1000;
/** A Client ID Metadata Document is refetched after its max-age, or this. */
const CIMD_MAX_AGE_MS = 24 * 60 * MINUTE;
const CIMD_MAX_BYTES = 5_000;

/** A client id that names its own metadata document (CIMD): an https URL with a path. */
export function isCimdId(id: string): boolean {
  if (!id.startsWith('https://')) return false;
  try {
    return new URL(id).pathname !== '/';
  } catch {
    return false;
  }
}

/** The redirect back to the client: `params` added to whatever query its registered URI already has. */
export function withParams(uri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  return url.href;
}

/**
 * The authorization server for MCP clients (#1352, docs/features/33). The MCP
 * SDK's handlers do the protocol — redirect matching, PKCE S256, error shapes,
 * form parsing — and call this for storage and decisions. A grant is an
 * `api_keys` row (written by the consent screen through `ApiKeysService`), so
 * what a token may do is resolved exactly like a key in `TokenAuthService`.
 *
 * Public clients only: Claude, Claude Code and every other client we target
 * register without a secret, so no client secret is ever stored.
 */
@Injectable()
export class OAuthService implements OAuthServerProvider, OAuthRegisteredClientsStore {
  private readonly logger = new Logger(OAuthService.name);
  private readonly urls: ReturnType<typeof oauthUrls>;
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly apiKeys: ApiKeysService,
    private readonly access: AccessService,
    config: ConfigService,
  ) {
    this.urls = oauthUrls(config);
    this.enabled = oauthEnabled(config);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this;
  }

  // ── Clients ───────────────────────────────────────────────────────────────

  async getClient(id: string): Promise<OAuthClientInformationFull | undefined> {
    const row = await this.prisma.oAuthClient.findUnique({ where: { id } });
    if (!isCimdId(id)) return row?.kind === 'dcr' ? toClient(row) : undefined;
    if (row?.fetchedAt && Date.now() - row.fetchedAt.getTime() < maxAgeOf(row)) return toClient(row);
    const fetched = await this.fetchMetadata(id);
    // A document that cannot be read right now keeps its last good copy, so a
    // blip on the client's host does not end every refresh against it.
    if (!fetched) return row ? toClient(row) : undefined;
    const data = {
      kind: 'cimd',
      name: clientName(fetched.doc.client_name, new URL(id).host),
      redirectUris: fetched.doc.redirect_uris,
      metadata: { ...fetched.doc, maxAgeMs: fetched.maxAgeMs },
      fetchedAt: new Date(),
    };
    const saved = await this.prisma.oAuthClient.upsert({ where: { id }, create: { id, ...data }, update: data });
    return toClient(saved);
  }

  /**
   * Dynamic registration (RFC 7591), an unauthenticated write: rate-limited per
   * IP in front (`mount.ts`), and here pruned and capped. A client is always
   * registered public, whatever auth method it asked for.
   */
  async registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> {
    const full = client as OAuthClientInformationFull;
    const stale = new Date(Date.now() - DCR_UNGRANTED_TTL_MS);
    await this.prisma.$executeRaw`
      DELETE FROM oauth_clients c
      WHERE c.kind = 'dcr' AND c.created_at < ${stale}
        AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.oauth_client_id = c.id)`;
    const [{ ungranted }] = await this.prisma.$queryRaw<{ ungranted: bigint }[]>`
      SELECT count(*) AS ungranted FROM oauth_clients c
      WHERE c.kind = 'dcr' AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.oauth_client_id = c.id)`;
    if (Number(ungranted) >= DCR_UNGRANTED_CAP) {
      this.logger.warn({ ungranted: Number(ungranted) }, 'OAuth client registration refused: cap of never-granted clients reached');
      throw new TemporarilyUnavailableError('Client registration is temporarily unavailable');
    }
    const { client_secret: _secret, client_secret_expires_at: _expires, ...metadata } = full;
    const registered: OAuthClientInformationFull = { ...metadata, token_endpoint_auth_method: 'none' };
    await this.prisma.oAuthClient.create({
      data: {
        id: full.client_id,
        kind: 'dcr',
        name: clientName(full.client_name, 'MCP client'),
        redirectUris: full.redirect_uris,
        metadata: registered as object,
      },
    });
    return registered;
  }

  private async fetchMetadata(id: string): Promise<{ doc: OAuthClientInformationFull; maxAgeMs: number } | null> {
    try {
      const res = await safeFetch(id, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
      const text = res.ok && Number(res.headers.get('content-length') ?? 0) <= CIMD_MAX_BYTES ? await res.text() : '';
      if (!text || text.length > CIMD_MAX_BYTES) return null;
      const raw = JSON.parse(text) as { client_id?: unknown; token_endpoint_auth_method?: unknown };
      const parsed = OAuthClientMetadataSchema.safeParse(raw);
      // The document must name itself, list where to send the person back, and be a public client.
      const method = raw.token_endpoint_auth_method;
      if (!parsed.success || raw.client_id !== id || !parsed.data.redirect_uris.length || (method !== undefined && method !== 'none')) {
        this.logger.warn({ clientId: id }, 'Client ID Metadata Document refused');
        return null;
      }
      const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1];
      return {
        doc: { ...parsed.data, client_id: id, token_endpoint_auth_method: 'none' },
        maxAgeMs: maxAge ? Math.min(Number(maxAge) * 1000, CIMD_MAX_AGE_MS) : CIMD_MAX_AGE_MS,
      };
    } catch (err) {
      this.logger.warn({ clientId: id, err }, 'Client ID Metadata Document unavailable');
      return null;
    }
  }

  // ── Authorize: a pending request the consent screen answers ──────────────

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    const now = Date.now();
    // Pruned on insert: a spent code stays a little past its expiry so a replay is still recognised.
    await this.prisma.oAuthRequest.deleteMany({ where: { expiresAt: { lt: new Date(now - REQUEST_TTL_MS) } } });
    const row = await this.prisma.oAuthRequest.create({
      data: {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state ?? null,
        resource: params.resource?.href ?? null,
        expiresAt: new Date(now + REQUEST_TTL_MS),
      },
    });
    res.redirect(302, `${this.urls.consent}?request=${row.id}`);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const row = await this.prisma.oAuthRequest.findUnique({ where: { codeHash: hashToken(code) } });
    if (!row || row.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    return row.codeChallenge;
  }

  /** Single use, by one guarded statement. A second redemption ends the grant the first one got (OAuth 2.1 §4.1.3). */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = await this.prisma.oAuthRequest.findUnique({ where: { codeHash: hashToken(code) } });
    if (!row?.apiKeyId || row.clientId !== client.client_id || (redirectUri !== undefined && redirectUri !== row.redirectUri)) {
      throw new InvalidGrantError('Invalid authorization code');
    }
    this.checkResource(resource);
    const { count } = await this.prisma.oAuthRequest.updateMany({
      where: { id: row.id, spentAt: null, expiresAt: { gt: new Date() } },
      data: { spentAt: new Date() },
    });
    if (!count) {
      if (row.spentAt) await this.endGrant(row.apiKeyId, 'code-replayed');
      throw new InvalidGrantError('Authorization code expired or already used');
    }
    return this.issue(row.apiKeyId);
  }

  /** Rotated on every use. A spent refresh token presented again ends the grant (OAuth 2.1 §4.3.1). */
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const row = await this.prisma.oAuthToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
      include: { apiKey: { select: { oauthClientId: true } } },
    });
    if (!row || row.kind !== 'refresh' || row.apiKey.oauthClientId !== client.client_id) throw new InvalidGrantError('Invalid refresh token');
    this.checkResource(resource);
    const { count } = await this.prisma.oAuthToken.updateMany({
      where: { id: row.id, spentAt: null, expiresAt: { gt: new Date() } },
      data: { spentAt: new Date() },
    });
    if (!count) {
      if (row.spentAt) await this.endGrant(row.apiKeyId, 'refresh-reused');
      throw new InvalidGrantError('Refresh token expired or already used');
    }
    return this.issue(row.apiKeyId);
  }

  /** RFC 7009. Either token ends the whole grant: that is what `claude mcp logout` means. */
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const row = await this.prisma.oAuthToken.findUnique({
      where: { tokenHash: hashToken(request.token) },
      include: { apiKey: { select: { oauthClientId: true } } },
    });
    if (row && row.apiKey.oauthClientId === client.client_id) await this.endGrant(row.apiKeyId, 'revoked-by-client');
  }

  /** The interface asks for it; `/v1/mcp` resolves tokens in `TokenAuthService`, and no mounted handler calls this. */
  async verifyAccessToken(): Promise<AuthInfo> {
    throw new InvalidTokenError('Access tokens are resolved by TokenAuthService');
  }

  // ── The consent screen (OAuthController, session-only) ────────────────────

  async view(id: string): Promise<OAuthRequestView> {
    const { request, client } = await this.pending(id);
    const cimd = isCimdId(request.clientId);
    return {
      client: { name: client.client_name ?? request.clientId, kind: cimd ? 'cimd' : 'dcr', domain: cimd ? new URL(request.clientId).host : null },
      redirectTo: redirectLabel(request.redirectUri),
      expiresAt: request.expiresAt.toISOString(),
    };
  }

  /**
   * Writes the grant with the key form's checks and cap, then binds a one-use
   * code to the request in one transaction: a second approval of the same
   * request finds it answered and writes nothing. A workspace pin is checked
   * like any call into that workspace (membership, enforced SSO) before the
   * grant exists, so the screen refuses up front.
   */
  async approve(principal: Principal, id: string, dto: Omit<CreateApiKeyDto, 'name'>): Promise<OAuthDecisionResponse> {
    const { request, client } = await this.pending(id);
    if (dto.workspaceId) await this.access.requireRole(principal, dto.workspaceId, 'viewer');
    const code = mintToken('koc_', 24);
    await this.prisma.withTransaction(async () => {
      const grant = await this.apiKeys.createGrant(
        principal,
        { ...dto, name: client.client_name ?? request.clientId, expiresInDays: dto.expiresInDays ?? OAUTH_GRANT_DEFAULT_DAYS },
        request.clientId,
      );
      const { count } = await this.prisma.oAuthRequest.updateMany({
        where: { id, apiKeyId: null, expiresAt: { gt: new Date() } },
        data: { apiKeyId: grant.id, codeHash: code.tokenHash, expiresAt: new Date(Date.now() + CODE_TTL_MS) },
      });
      if (!count) throw new NotFoundException(t('error.auth.oauthRequestGone'));
    });
    return { redirect: withParams(request.redirectUri, { code: code.token, state: request.state }) };
  }

  async deny(id: string): Promise<OAuthDecisionResponse> {
    const { request } = await this.pending(id);
    const { count } = await this.prisma.oAuthRequest.deleteMany({ where: { id, apiKeyId: null } });
    if (!count) throw new NotFoundException(t('error.auth.oauthRequestGone'));
    return { redirect: withParams(request.redirectUri, { error: 'access_denied', state: request.state }) };
  }

  private async pending(id: string) {
    if (!this.enabled) throw new NotFoundException(t('error.auth.oauthRequestGone'));
    const request = await this.prisma.oAuthRequest.findUnique({ where: { id } });
    if (!request || request.apiKeyId || request.expiresAt <= new Date()) throw new NotFoundException(t('error.auth.oauthRequestGone'));
    const client = await this.getClient(request.clientId);
    if (!client) throw new NotFoundException(t('error.auth.oauthClientGone'));
    return { request, client };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** A token pair for a live grant. Nothing here moves the grant's own expiry: a token never extends what made it. */
  private async issue(apiKeyId: string): Promise<OAuthTokens> {
    const grant = await this.prisma.apiKey.findUnique({ where: { id: apiKeyId }, include: { user: { select: { disabledAt: true } } } });
    const now = Date.now();
    if (!grant?.oauthClientId || grant.revokedAt || grant.user.disabledAt || !grant.expiresAt || grant.expiresAt.getTime() <= now) {
      throw new InvalidGrantError('The grant has ended');
    }
    const accessExpires = Math.min(now + ACCESS_TTL_MS, grant.expiresAt.getTime());
    const access = mintToken(OAUTH_ACCESS_PREFIX, 24);
    const refresh = mintToken(OAUTH_REFRESH_PREFIX, 32);
    await this.prisma.$transaction([
      // A spent refresh token is kept a day, long enough to recognise its replay.
      this.prisma.oAuthToken.deleteMany({
        where: { apiKeyId, OR: [{ expiresAt: { lt: new Date(now) } }, { spentAt: { lt: new Date(now - 24 * 60 * MINUTE) } }] },
      }),
      this.prisma.oAuthToken.createMany({
        data: [
          { apiKeyId, kind: 'access', tokenHash: access.tokenHash, expiresAt: new Date(accessExpires) },
          { apiKeyId, kind: 'refresh', tokenHash: refresh.tokenHash, expiresAt: grant.expiresAt },
        ],
      }),
    ]);
    return {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: Math.floor((accessExpires - now) / 1000),
      refresh_token: refresh.token,
    };
  }

  private async endGrant(apiKeyId: string, reason: 'code-replayed' | 'refresh-reused' | 'revoked-by-client'): Promise<void> {
    const grant = await this.prisma.apiKey.findUnique({ where: { id: apiKeyId }, select: { userId: true, workspaceId: true, name: true } });
    const { count } = await this.prisma.apiKey.updateMany({ where: { id: apiKeyId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.prisma.oAuthToken.deleteMany({ where: { apiKeyId } });
    if (count && grant) {
      void this.audit.record({
        workspaceId: grant.workspaceId,
        actor: grant.userId,
        action: 'oauth.revoked',
        params: { name: grant.name, reason },
        target: apiKeyId,
        ok: reason === 'revoked-by-client',
      });
    }
  }

  /** RFC 8707: a client that names a resource must name this one. */
  private checkResource(resource: URL | undefined): void {
    if (resource && resource.href !== this.urls.resource) throw new InvalidTargetError(`This server issues tokens for ${this.urls.resource} only`);
  }
}

function toClient(row: OAuthClient): OAuthClientInformationFull {
  const metadata = row.metadata as Partial<OAuthClientInformationFull>;
  return {
    ...metadata,
    client_id: row.id,
    client_name: row.name,
    redirect_uris: row.redirectUris as string[],
    token_endpoint_auth_method: 'none',
  };
}

function maxAgeOf(row: OAuthClient): number {
  const stored = (row.metadata as { maxAgeMs?: unknown }).maxAgeMs;
  return typeof stored === 'number' ? stored : CIMD_MAX_AGE_MS;
}

/** The host a person will be sent back to, or a native app's scheme. */
function redirectLabel(uri: string): string {
  const url = new URL(uri);
  return url.host || url.protocol.replace(/:$/, '');
}

/** A client's own name, trimmed to what the consent screen and the key list can show. */
function clientName(name: string | undefined, fallback: string): string {
  const trimmed = name?.replace(/\s+/g, ' ').trim().slice(0, 80);
  return trimmed || fallback;
}
