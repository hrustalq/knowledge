import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type FigmaOauthGrant, type PrismaClient } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { FIGMA_GRANT_CONFIG_KEY, FIGMA_HANDLE_CONFIG_KEY, FIGMA_TOKEN_EXPIRES_CONFIG_KEY } from '@knowledge/contracts';
import { decryptSecret, encryptSecret, parseKey } from '../ai/secret-box.js';
import { safeFetch } from '../common/safe-fetch.js';
import type { Env } from '../config/env.js';
import { FIGMA_API } from '../connectors/adapters/figma.js';
import { signState, verifyState, type OauthState } from '../connectors/github/github-jwt.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Connect with Figma (#557, docs/features/64): the authorization code flow
 * with PKCE, and the grant every OAuth connector dials with.
 *
 * One grant per Figma person, because Figma keeps one access token per app per
 * user and a refresh invalidates the previous one: two copies would revoke
 * each other. Connectors name the grant in `config.figmaGrant`; the API and the
 * worker both read it, so a refresh is single-flight across processes — one
 * guarded update takes a lease, and everyone else re-reads.
 *
 * Shaped like `GithubOauthService`, and in `ConnectorsCoreModule` because the
 * worker's snapshot and change sweeps call Figma too.
 */

export const FIGMA_OAUTH_SCOPES = 'folders:read file_content:read file_metadata:read current_user:read';

/** Tokens live 90 days; renewing a few minutes early keeps a long sweep from outliving one. */
const RENEW_MARGIN_MS = 5 * 60_000;
/** How long a refresh may hold the lease, and so how long a loser waits for it. */
const LEASE_MS = 30_000;
const WAIT_STEP_MS = 250;
/** A round trip through a browser, not a session. Figma's code itself dies in 30 s. */
const STATE_TTL_SECONDS = 600;

export interface FigmaOauthState extends OauthState {
  connectorId: string;
  /** The PKCE verifier, sealed: the state travels through figma.com in a URL. */
  pkce: string;
}

@Injectable()
export class FigmaOauthService {
  private readonly logger = new Logger(FigmaOauthService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly key: Buffer | null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {
    this.clientId = this.config.get('FIGMA_OAUTH_CLIENT_ID', { infer: true }).trim();
    this.clientSecret = this.config.get('FIGMA_OAUTH_CLIENT_SECRET', { infer: true }).trim();
    this.key = parseKey(this.config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
    if (this.clientId && !this.configured) {
      this.logger.warn('Figma OAuth needs FIGMA_OAUTH_CLIENT_SECRET and SETTINGS_ENCRYPTION_KEY too; offering the token field only');
    }
  }

  /** An empty client id is the off switch; a token that cannot be sealed is never stored. */
  get configured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.key);
  }

  /** Derived, so it matches the app registration byte for byte with one fewer env var. */
  redirectUri(): string {
    return `${this.config.get('API_PUBLIC_URL', { infer: true }).replace(/\/+$/, '')}/v1/connectors/figma/callback`;
  }

  authorizeUrl(workspaceId: string, userId: string, connectorId: string, returnTo: string): string | null {
    if (!this.configured) return null;
    const verifier = randomBytes(32).toString('base64url');
    const state: FigmaOauthState = {
      workspaceId,
      userId,
      connectorId,
      returnTo,
      pkce: encryptSecret(verifier, this.key),
      nonce: randomUUID(),
      exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
    };
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri(),
      scope: FIGMA_OAUTH_SCOPES,
      state: signState(state, this.key!),
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    return `https://www.figma.com/oauth?${params.toString()}`;
  }

  /** Null for a forged, malformed or expired state. The callback is public; this is the gate. */
  verify(raw: string): FigmaOauthState | null {
    if (!this.key) return null;
    const state = verifyState<FigmaOauthState>(raw, this.key);
    return state?.connectorId && state.pkce ? state : null;
  }

  /**
   * Exchanges the code, stores the grant and points the connector at it.
   * False rather than a throw: the caller is a public callback whose only
   * honest answer is a redirect. A replayed state fails here too: its code is
   * spent, and a fresh code was issued for another state's PKCE challenge.
   */
  async completeAuthorization(state: FigmaOauthState, code: string): Promise<boolean> {
    if (!this.configured) return false;
    const verifier = decryptSecret(state.pkce, this.key);
    if (!verifier) return false;
    const token = await this.post('token', {
      redirect_uri: this.redirectUri(),
      code,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });
    if (!token?.access_token || !token.refresh_token || !token.user_id_string) return false;
    const handle = await this.handleOf(token.access_token);
    if (handle === null) return false;

    const figmaUserId = token.user_id_string;
    const data = {
      handle,
      accessToken: encryptSecret(token.access_token, this.key),
      refreshToken: encryptSecret(token.refresh_token, this.key),
      expiresAt: expiry(token.expires_in),
      refreshingUntil: null,
      connectedBy: state.userId,
    };
    return this.prisma.$transaction(async (tx) => {
      await tx.figmaOauthGrant.upsert({ where: { figmaUserId }, create: { figmaUserId, ...data }, update: data });
      // The state names the workspace, so a connector moved or deleted since is not bound.
      const connector = await tx.connector.findFirst({
        where: { id: state.connectorId, workspaceId: state.workspaceId, kind: 'figma' },
        select: { config: true },
      });
      if (connector) {
        const config = { ...((connector.config ?? {}) as Record<string, unknown>) };
        // A switch from a token: its typed-in expiry no longer means anything.
        delete config[FIGMA_TOKEN_EXPIRES_CONFIG_KEY];
        config[FIGMA_GRANT_CONFIG_KEY] = figmaUserId;
        config[FIGMA_HANDLE_CONFIG_KEY] = handle;
        await tx.connector.update({
          where: { id: state.connectorId },
          data: { config: config as Prisma.InputJsonValue, credential: null, credentialHint: null },
        });
      }
      await pruneFigmaGrants(tx);
      return Boolean(connector);
    });
  }

  /**
   * A usable access token for a grant, refreshed when about to expire or when
   * Figma just refused `rejected`. Null = not connected, or the grant lapsed.
   */
  async tokenFor(figmaUserId: string, rejected?: string): Promise<string | null> {
    if (!this.configured) return null;
    for (let waited = 0; waited <= LEASE_MS; waited += WAIT_STEP_MS) {
      const row = await this.prisma.figmaOauthGrant.findUnique({ where: { figmaUserId } });
      if (!row) return null;
      const token = decryptSecret(row.accessToken, this.key);
      if (token && token !== rejected && row.expiresAt.getTime() - RENEW_MARGIN_MS > Date.now()) return token;

      // The one guarded statement: whoever still sees this token, with no live
      // lease, refreshes. Matching the ciphertext makes it a compare-and-swap.
      const now = new Date();
      const { count } = await this.prisma.figmaOauthGrant.updateMany({
        where: { figmaUserId, accessToken: row.accessToken, OR: [{ refreshingUntil: null }, { refreshingUntil: { lt: now } }] },
        data: { refreshingUntil: new Date(now.getTime() + LEASE_MS) },
      });
      if (count === 1) return this.refresh(row);
      await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
    }
    return null;
  }

  /** Unbinds a connector; its grant goes too once nothing else references it. */
  async disconnect(connectorId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.connector.findUnique({ where: { id: connectorId }, select: { config: true } });
      if (!row) return;
      const config = { ...((row.config ?? {}) as Record<string, unknown>) };
      delete config[FIGMA_GRANT_CONFIG_KEY];
      delete config[FIGMA_HANDLE_CONFIG_KEY];
      await tx.connector.update({ where: { id: connectorId }, data: { config: config as Prisma.InputJsonValue } });
      await pruneFigmaGrants(tx);
    });
  }

  // --- internals ---

  /** Holds the lease; releases it on failure so the next caller can try. */
  private async refresh(row: FigmaOauthGrant): Promise<string | null> {
    const refreshToken = decryptSecret(row.refreshToken, this.key);
    const body = refreshToken ? await this.post('refresh', { refresh_token: refreshToken }) : null;
    if (!body?.access_token) {
      await this.prisma.figmaOauthGrant.updateMany({ where: { figmaUserId: row.figmaUserId }, data: { refreshingUntil: null } });
      return null;
    }
    await this.prisma.figmaOauthGrant.update({
      where: { figmaUserId: row.figmaUserId },
      data: { accessToken: encryptSecret(body.access_token, this.key), expiresAt: expiry(body.expires_in), refreshingUntil: null },
    });
    return body.access_token;
  }

  /** Figma's token endpoints: form-encoded, client authenticated with HTTP Basic. */
  private async post(endpoint: 'token' | 'refresh', form: Record<string, string>): Promise<TokenResponse | null> {
    try {
      const res = await safeFetch(
        `${FIGMA_API}/v1/oauth/${endpoint}`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: new URLSearchParams(form).toString(),
        },
        false,
      );
      if (!res.ok) {
        this.logger.warn(`Figma OAuth ${endpoint} refused: ${res.status}`);
        return null;
      }
      return (await res.json()) as TokenResponse;
    } catch (err) {
      this.logger.warn(`Figma OAuth ${endpoint} errored: ${(err as Error).message}`);
      return null;
    }
  }

  private async handleOf(accessToken: string): Promise<string | null> {
    try {
      const res = await safeFetch(`${FIGMA_API}/v1/me`, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } }, false);
      if (!res.ok) return null;
      const me = (await res.json()) as { handle?: string; email?: string };
      return me.handle ?? me.email ?? '';
    } catch {
      return null;
    }
  }
}

/**
 * Deletes every grant no connector references: after a disconnect, a rebind,
 * a connector's deletion and a workspace teardown. One statement, so it is
 * idempotent and safe to run from anywhere.
 */
export async function pruneFigmaGrants(db: Pick<PrismaClient, '$executeRaw'>): Promise<void> {
  await db.$executeRaw`DELETE FROM figma_oauth_grants g WHERE NOT EXISTS (
    SELECT 1 FROM connectors c WHERE c.kind = 'figma' AND c.config->>${FIGMA_GRANT_CONFIG_KEY} = g.figma_user_id)`;
}

/** Figma's `expires_in` is seconds; 90 days when it says nothing. */
function expiry(expiresIn: number | undefined): Date {
  return new Date(Date.now() + (expiresIn ?? 90 * 86_400) * 1000);
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user_id_string?: string;
}
