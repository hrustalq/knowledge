import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { decryptSecret, encryptSecret, parseKey } from '../../ai/secret-box.js';
import { safeFetch } from '../../common/safe-fetch.js';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { signState, verifyState, type OauthState } from './github-jwt.js';

/**
 * The user half of the GitHub integration (docs/features/28).
 *
 * This exists for exactly one reason: the account switcher must show only the
 * installations *this person* can reach. No App-level credential can answer
 * that — `GET /app/installations` lists every account the App is installed on,
 * including other people's orgs — so listing accounts honestly requires acting
 * as the user. `GET /user/installations` does, and needs a user token.
 *
 * It is not what a sync authenticates as. See `GithubAppService`.
 *
 * Tokens are stored through the same `secret-box` the connector credential
 * uses, and are keyed by our user id rather than by workspace: a GitHub
 * identity belongs to a person, and one person browsing two workspaces is still
 * one identity.
 */

/** Refresh this far ahead of expiry so a long request cannot outlive its token. */
const RENEW_MARGIN_MS = 120_000;

/** A state parameter is a round trip through a browser, not a session. Ten minutes is generous. */
const STATE_TTL_SECONDS = 600;

export interface GithubIdentity {
  githubLogin: string;
  githubAvatarUrl: string | null;
}

@Injectable()
export class GithubOauthService {
  private readonly logger = new Logger(GithubOauthService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly key: Buffer | null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {
    this.clientId = this.config.get('GITHUB_APP_CLIENT_ID', { infer: true }).trim();
    this.clientSecret = this.config.get('GITHUB_APP_CLIENT_SECRET', { infer: true }).trim();
    this.key = parseKey(this.config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
  }

  /**
   * Both halves are required, and the encryption key is one of them: a user
   * token that cannot be encrypted must not be stored in the clear, so the
   * OAuth leg is simply not offered without it.
   */
  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.key);
  }

  // --- the state parameter ---

  /**
   * Signs the state for a redirect. The key is the settings encryption key
   * rather than a dedicated one: it is already required for this feature, and a
   * second secret to configure would be a second secret to forget.
   */
  sign(workspaceId: string, userId: string, returnTo: string): string | null {
    if (!this.key) return null;
    return signState(
      { workspaceId, userId, returnTo, nonce: randomUUID(), exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS },
      this.key,
    );
  }

  /** Null for a forged, malformed or expired state. The callback is public; this is the gate. */
  verify(raw: string): OauthState | null {
    if (!this.key) return null;
    return verifyState(raw, this.key);
  }

  // --- the authorization code flow ---

  authorizeUrl(state: string, redirectUri: string): string | null {
    if (!this.configured) return null;
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      state,
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchanges the code and records the identity.
   *
   * Returns false rather than throwing: the caller is a public callback whose
   * only honest response to a bad exchange is a redirect carrying an error, not
   * a stack trace.
   */
  async completeAuthorization(code: string, userId: string, redirectUri: string): Promise<boolean> {
    if (!this.configured) return false;
    try {
      const res = await safeFetch(
        'https://github.com/login/oauth/access_token',
        {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        },
        false,
      );
      if (!res.ok) return false;

      const body = (await res.json()) as TokenResponse;
      // GitHub answers 200 with an `error` field for a bad or reused code.
      if (!body.access_token) {
        this.logger.warn(`OAuth exchange refused: ${body.error ?? 'no access_token'}`);
        return false;
      }

      const identity = await this.fetchIdentity(body.access_token);
      if (!identity) return false;

      await this.store(userId, body, identity);
      return true;
    } catch (err) {
      this.logger.warn(`OAuth exchange errored: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * A usable access token for this person, refreshing if it is about to expire.
   *
   * Null means "not connected, or the connection has lapsed beyond repair" —
   * the picker turns that into the Connect GitHub button rather than an error.
   */
  async tokenFor(userId: string): Promise<string | null> {
    if (!this.key) return null;
    const row = await this.prisma.githubUserToken.findUnique({ where: { userId } });
    if (!row) return null;

    const fresh = !row.expiresAt || row.expiresAt.getTime() - RENEW_MARGIN_MS > Date.now();
    if (fresh) return decryptSecret(row.accessToken, this.key);

    // Expired, and a refresh token is the only way back. Without one the App
    // does not have expiring tokens switched on, in which case `expiresAt` is
    // null and we never reach here.
    const refresh = decryptSecret(row.refreshToken, this.key);
    if (!refresh || (row.refreshExpiresAt && row.refreshExpiresAt.getTime() < Date.now())) {
      return null;
    }
    return this.refresh(userId, refresh);
  }

  async identityFor(userId: string): Promise<GithubIdentity | null> {
    const row = await this.prisma.githubUserToken.findUnique({ where: { userId } });
    return row ? { githubLogin: row.githubLogin, githubAvatarUrl: row.githubAvatarUrl } : null;
  }

  /** Forgetting the identity, for a disconnect. The installations stay: they are the workspace's. */
  async disconnect(userId: string): Promise<void> {
    await this.prisma.githubUserToken.deleteMany({ where: { userId } });
  }

  // --- internals ---

  private async refresh(userId: string, refreshToken: string): Promise<string | null> {
    try {
      const res = await safeFetch(
        'https://github.com/login/oauth/access_token',
        {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
          }),
        },
        false,
      );
      if (!res.ok) return null;

      const body = (await res.json()) as TokenResponse;
      if (!body.access_token) return null;

      const identity = await this.fetchIdentity(body.access_token);
      if (!identity) return null;
      await this.store(userId, body, identity);
      return body.access_token;
    } catch (err) {
      this.logger.warn(`OAuth refresh errored: ${(err as Error).message}`);
      return null;
    }
  }

  private async fetchIdentity(accessToken: string): Promise<RawUser | null> {
    const res = await safeFetch(
      `${this.config.get('GITHUB_API_URL', { infer: true }).replace(/\/+$/, '')}/user`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'knowledge-connector',
          authorization: `Bearer ${accessToken}`,
        },
      },
      false,
    );
    return res.ok ? ((await res.json()) as RawUser) : null;
  }

  private async store(userId: string, token: TokenResponse, identity: RawUser): Promise<void> {
    const now = Date.now();
    const data = {
      githubUserId: BigInt(identity.id),
      githubLogin: identity.login,
      githubAvatarUrl: identity.avatar_url ?? null,
      accessToken: encryptSecret(token.access_token!, this.key),
      refreshToken: token.refresh_token ? encryptSecret(token.refresh_token, this.key) : null,
      // Absent when the App does not expire user tokens, which is a valid
      // configuration — `tokenFor` reads null as "never stale".
      expiresAt: token.expires_in ? new Date(now + token.expires_in * 1000) : null,
      refreshExpiresAt: token.refresh_token_expires_in
        ? new Date(now + token.refresh_token_expires_in * 1000)
        : null,
    };
    await this.prisma.githubUserToken.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
}

interface RawUser {
  id: number;
  login: string;
  avatar_url?: string | null;
}
