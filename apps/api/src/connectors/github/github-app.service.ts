import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { safeFetch } from '../../common/safe-fetch.js';
import type { Env } from '../../config/env.js';
import { appJwt, parsePrivateKey } from './github-jwt.js';

/**
 * The App half of the GitHub integration (docs/features/30).
 *
 * This is what a *sync* authenticates as. It is deliberately separate from the
 * user's OAuth identity in `GithubOauthService`: an installation token is
 * server-to-server and outlives whoever set the connector up, so a scheduled
 * sync keeps working after that person's OAuth token has expired or their
 * account is gone. Browsing uses the user token; syncing uses this.
 *
 * Every method answers null rather than throwing when the App is not
 * configured. `GITHUB_APP_ID=''` is the supported off state — the picker is not
 * offered and connectors that hold a personal access token are untouched.
 */

/** GitHub's installation tokens last an hour; renew a minute early to cover flight time. */
const RENEW_MARGIN_MS = 60_000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

export interface InstallationAccount {
  installationId: string;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  accountAvatarUrl: string | null;
  repositorySelection: 'all' | 'selected';
  suspended: boolean;
}

@Injectable()
export class GithubAppService {
  private readonly logger = new Logger(GithubAppService.name);
  private readonly appId: string;
  private readonly slug: string;
  private readonly privateKey: string | null;
  readonly apiUrl: string;

  /**
   * Installation tokens, in memory only.
   *
   * Not Redis: the token is worth an hour at most, minting a fresh one is a
   * single request, and a shared cache would put a live repository credential
   * in a second system for no gain. Two API processes minting separately is
   * fine — GitHub issues concurrent tokens for the same installation.
   */
  private readonly tokens = new Map<string, CachedToken>();

  constructor(private readonly config: ConfigService<Env, true>) {
    this.appId = this.config.get('GITHUB_APP_ID', { infer: true }).trim();
    this.slug = this.config.get('GITHUB_APP_SLUG', { infer: true }).trim();
    this.apiUrl = this.config.get('GITHUB_API_URL', { infer: true }).replace(/\/+$/, '');
    this.privateKey = parsePrivateKey(this.config.get('GITHUB_APP_PRIVATE_KEY', { infer: true }));

    if (this.appId && !this.privateKey) {
      // Worth a loud line: the App looks configured, so the picker will be
      // offered, and every token mint will fail at the first install.
      this.logger.warn('GITHUB_APP_ID is set but GITHUB_APP_PRIVATE_KEY is missing or unreadable');
    }
  }

  /** False disables the whole picker; the PAT path is unaffected either way. */
  get configured(): boolean {
    return Boolean(this.appId && this.privateKey);
  }

  /**
   * Where to send a browser to install the App on another account or org.
   *
   * `state` rides along so the callback can tell which workspace asked. GitHub
   * echoes it back on the App's configured Setup URL.
   */
  installUrl(state: string): string | null {
    if (!this.configured || !this.slug) return null;
    return `https://github.com/apps/${encodeURIComponent(this.slug)}/installations/new?state=${encodeURIComponent(state)}`;
  }

  /**
   * A token scoped to one installation, cached until just before it expires.
   *
   * Null when the App is unconfigured or GitHub refuses — the caller turns that
   * into "this connector has no usable credential", which is a better run
   * failure than a thrown 500 from inside a worker.
   */
  async installationToken(installationId: string): Promise<string | null> {
    if (!this.configured) return null;

    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - RENEW_MARGIN_MS > Date.now()) return cached.token;

    try {
      const res = await this.appRequest(`/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
        method: 'POST',
      });
      if (!res.ok) {
        this.logger.warn(`installation ${installationId} token mint failed: ${res.status}`);
        this.tokens.delete(installationId);
        return null;
      }
      const body = (await res.json()) as { token?: string; expires_at?: string };
      if (!body.token) return null;

      const expiresAt = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 3_600_000;
      this.tokens.set(installationId, { token: body.token, expiresAt });
      return body.token;
    } catch (err) {
      this.logger.warn(`installation ${installationId} token mint errored: ${(err as Error).message}`);
      return null;
    }
  }

  /** The App's own view of one installation — the account details recorded at install time. */
  async installation(installationId: string): Promise<InstallationAccount | null> {
    if (!this.configured) return null;
    const res = await this.appRequest(`/app/installations/${encodeURIComponent(installationId)}`);
    if (!res.ok) return null;
    return toAccount((await res.json()) as RawInstallation);
  }

  /** A request authenticated as the App itself, for the two calls above. */
  private appRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const jwt = appJwt(this.appId, this.privateKey!);
    return safeFetch(
      `${this.apiUrl}${path}`,
      {
        ...init,
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'knowledge-connector',
          'x-github-api-version': '2022-11-28',
          authorization: `Bearer ${jwt}`,
          ...(init.headers as Record<string, string> | undefined),
        },
      },
      // GitHub is a public host. Private addresses stay refused even when
      // CONNECTOR_ALLOW_PRIVATE_URLS is on for self-hosted Confluence.
      false,
    );
  }
}

interface RawInstallation {
  id: number;
  account?: { login?: string; type?: string; avatar_url?: string } | null;
  repository_selection?: string;
  suspended_at?: string | null;
}

export function toAccount(raw: RawInstallation): InstallationAccount {
  return {
    installationId: String(raw.id),
    accountLogin: raw.account?.login ?? 'unknown',
    accountType: raw.account?.type === 'User' ? 'User' : 'Organization',
    accountAvatarUrl: raw.account?.avatar_url ?? null,
    repositorySelection: raw.repository_selection === 'selected' ? 'selected' : 'all',
    suspended: Boolean(raw.suspended_at),
  };
}
