import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Credential } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PlaudLinkResponse } from '@knowledge/contracts';
import { decryptSecret, encryptSecret, parseKey } from '../ai/secret-box.js';
import { slots } from '../ai/secret-slots.js';
import { safeFetch } from '../common/safe-fetch.js';
import type { Env } from '../config/env.js';
import { signState, verifyState, type OauthState } from '../connectors/github/github-jwt.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PLAUD_MCP_URL, PLAUD_ORIGIN, plaudTool } from './plaud.client.js';

/**
 * Link a Plaud account (#864): the authorization code flow with PKCE against
 * Plaud's hosted MCP server, as a public client the operator registered once
 * (`POST https://mcp.plaud.ai/register`), so there is no client secret.
 *
 * The sign-in is the person's own `credentials` row (#857) and never a
 * workspace connection: a memo is private to its uploader, and a shared
 * sign-in would let one person import another's recordings. One row per
 * person; linking again replaces it.
 *
 * Plaud rotates the refresh token on every refresh and it lives 7 days, so a
 * refresh is single-flight (one guarded update takes a lease, as for Figma)
 * and writes both tokens.
 */

/** A Plaud sign-in's credential; the account is the Plaud user id. */
const PLAUD_SIGN_IN = { provider: 'plaud', method: 'oauth' } as const;

/** Access tokens live a day; renewing a few minutes early keeps a long import from outliving one. */
const RENEW_MARGIN_MS = 5 * 60_000;
/** How long a refresh may hold the lease, and so how long a loser waits for it. */
const LEASE_MS = 30_000;
const WAIT_STEP_MS = 250;
/** A round trip through a browser, not a session. */
const STATE_TTL_SECONDS = 600;
const DAY_MS = 86_400_000;

export interface PlaudOauthState extends OauthState {
  /** The PKCE verifier, sealed: the state travels through plaud.ai in a URL. */
  pkce: string;
}

@Injectable()
export class PlaudOauthService {
  private readonly logger = new Logger(PlaudOauthService.name);
  private readonly clientId: string;
  private readonly key: Buffer | null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {
    this.clientId = this.config.get('PLAUD_OAUTH_CLIENT_ID', { infer: true }).trim();
    this.key = parseKey(this.config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
    if (this.clientId && !this.key) this.logger.warn('Plaud needs SETTINGS_ENCRYPTION_KEY too; linking is not offered');
  }

  /** An empty client id is the off switch; a token that cannot be sealed is never stored. */
  get configured(): boolean {
    return Boolean(this.clientId && this.key);
  }

  /** Derived, so it matches the client registration byte for byte with one fewer env var. */
  redirectUri(): string {
    return `${this.config.get('API_PUBLIC_URL', { infer: true }).replace(/\/+$/, '')}/v1/plaud/callback`;
  }

  authorizeUrl(workspaceId: string, userId: string, returnTo: string): string | null {
    if (!this.configured) return null;
    const verifier = randomBytes(32).toString('base64url');
    const nonce = randomUUID();
    const state: PlaudOauthState = {
      workspaceId,
      userId,
      returnTo,
      pkce: encryptSecret(verifier, this.key, slots.oauthStatePkce('plaud', { workspaceId, nonce })),
      nonce,
      exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
    };
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri(),
      state: signState(state, this.key!),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: PLAUD_MCP_URL,
    });
    return `${PLAUD_ORIGIN}/authorize?${params.toString()}`;
  }

  /** Null for a forged, malformed or expired state. The callback is public; this is the gate. */
  verify(raw: string): PlaudOauthState | null {
    if (!this.key) return null;
    const state = verifyState<PlaudOauthState>(raw, this.key);
    return state?.pkce ? state : null;
  }

  /**
   * Exchanges the code and stores the sign-in as the caller's credential. An
   * outcome rather than a throw: the caller is a public callback whose only
   * honest answer is a redirect. A replayed state fails here too — its code is
   * spent, and a fresh code belongs to another state's PKCE challenge.
   */
  async completeAuthorization(state: PlaudOauthState, code: string): Promise<'connected' | 'auth-failed'> {
    if (!this.configured) return 'auth-failed';
    const verifier = decryptSecret(state.pkce, this.key, slots.oauthStatePkce('plaud', state));
    if (!verifier) return 'auth-failed';
    const token = await this.post({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri(), code_verifier: verifier });
    if (!token?.access_token || !token.refresh_token) return 'auth-failed';

    let me: { id?: string; nickname?: string; email?: string };
    try {
      me = await plaudTool(token.access_token, 'get_current_user');
    } catch (err) {
      this.logger.warn(`Plaud sign-in could not be identified: ${(err as Error).message}`);
      return 'auth-failed';
    }
    if (typeof me?.id !== 'string' || !me.id) return 'auth-failed';

    const signIn = (id: string) => ({ accountId: me.id, accountLabel: me.nickname || me.email || '', ...this.sealed(token, { id }), refreshingUntil: null });
    await this.prisma.$transaction(async (tx) => {
      const held = await tx.credential.findFirst({ where: { ...PLAUD_SIGN_IN, userId: state.userId }, orderBy: { createdAt: 'asc' } });
      if (held) await tx.credential.update({ where: { id: held.id }, data: signIn(held.id) });
      else {
        const id = randomUUID();
        await tx.credential.create({ data: { id, ...PLAUD_SIGN_IN, userId: state.userId, site: null, ...signIn(id) } });
      }
    });
    return 'connected';
  }

  /** What the person sees: whether linking is offered, whether they are linked, and whether the sign-in lapsed. */
  async status(userId: string): Promise<PlaudLinkResponse> {
    const row = this.configured ? await this.own(userId) : null;
    return {
      configured: this.configured,
      linked: Boolean(row),
      accountLabel: row?.accountLabel ?? null,
      needsReconnect: Boolean(row) && lapsed(row!),
    };
  }

  /**
   * A usable access token for the person's Plaud sign-in, refreshed when about
   * to expire or when Plaud just refused `rejected`. Null = not linked, or the
   * sign-in lapsed (seven days with no refresh, or revoked at Plaud).
   */
  async tokenFor(userId: string, rejected?: string): Promise<string | null> {
    if (!this.configured) return null;
    for (let waited = 0; waited <= LEASE_MS; waited += WAIT_STEP_MS) {
      const row = await this.own(userId);
      if (!row) return null;
      const token = decryptSecret(row.secret, this.key, slots.credential(row, 'secret'));
      if (token && token !== rejected && row.expiresAt && row.expiresAt.getTime() - RENEW_MARGIN_MS > Date.now()) return token;
      if (lapsed(row)) return null;

      // The one guarded statement: whoever still sees this token, with no live
      // lease, refreshes. Matching the ciphertext makes it a compare-and-swap,
      // which matters more here than for Figma: a second refresh with the
      // rotated-away token would be refused and read as a lapsed sign-in.
      const now = new Date();
      const { count } = await this.prisma.credential.updateMany({
        where: { id: row.id, secret: row.secret, OR: [{ refreshingUntil: null }, { refreshingUntil: { lt: now } }] },
        data: { refreshingUntil: new Date(now.getTime() + LEASE_MS) },
      });
      if (count === 1) return this.refresh(row);
      await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
    }
    return null;
  }

  /**
   * Forgets the sign-in. Plaud's HTTP server offers no revoke (its `logout`
   * tool exists only in the local package), so the grant stays listed in the
   * person's Plaud account until its refresh token expires, with no copy of
   * the token left here to use it.
   */
  async unlink(userId: string): Promise<void> {
    await this.prisma.credential.deleteMany({ where: { ...PLAUD_SIGN_IN, userId } });
  }

  // --- internals ---

  private own(userId: string): Promise<Credential | null> {
    return this.prisma.credential.findFirst({ where: { ...PLAUD_SIGN_IN, userId }, orderBy: { createdAt: 'asc' } });
  }

  /** Holds the lease; releases it on failure so the next caller can try. */
  private async refresh(row: Credential): Promise<string | null> {
    const refreshToken = decryptSecret(row.refreshSecret, this.key, slots.credential(row, 'refresh_secret'));
    const body = refreshToken ? await this.post({ grant_type: 'refresh_token', refresh_token: refreshToken }) : null;
    if (!body?.access_token) {
      await this.prisma.credential.updateMany({ where: { id: row.id }, data: { refreshingUntil: null } });
      return null;
    }
    await this.prisma.credential.update({ where: { id: row.id }, data: { ...this.sealed(body, row), refreshingUntil: null } });
    return body.access_token;
  }

  /** Both tokens and their expiries. A refresh that returns no new refresh token keeps the one it had. */
  private sealed(token: TokenResponse, row: { id: string } & Partial<Pick<Credential, 'refreshSecret' | 'refreshExpiresAt'>>) {
    const refreshExp = token.refresh_token ? expOf(token.refresh_token) : undefined;
    const previous = row;
    return {
      secret: encryptSecret(token.access_token!, this.key, slots.credential(row, 'secret')),
      expiresAt: new Date(Date.now() + (token.expires_in ?? 86_400) * 1000),
      refreshSecret: token.refresh_token ? encryptSecret(token.refresh_token, this.key, slots.credential(row, 'refresh_secret')) : (previous.refreshSecret ?? null),
      refreshExpiresAt: token.refresh_token
        ? new Date(refreshExp ? refreshExp * 1000 : Date.now() + 7 * DAY_MS)
        : (previous.refreshExpiresAt ?? null),
    };
  }

  /** Plaud's token endpoint: form-encoded, a public client named in the body. */
  private async post(form: Record<string, string>): Promise<TokenResponse | null> {
    try {
      const res = await safeFetch(`${PLAUD_ORIGIN}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ ...form, client_id: this.clientId, resource: PLAUD_MCP_URL }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        this.logger.warn(`Plaud OAuth ${form.grant_type} refused: ${res.status}`);
        return null;
      }
      return (await res.json()) as TokenResponse;
    } catch (err) {
      this.logger.warn(`Plaud OAuth ${form.grant_type} errored: ${(err as Error).message}`);
      return null;
    }
  }
}

/** The refresh token is past its life: only signing in again helps. */
function lapsed(row: Pick<Credential, 'refreshSecret' | 'refreshExpiresAt'>): boolean {
  return !row.refreshSecret || (row.refreshExpiresAt !== null && row.refreshExpiresAt.getTime() <= Date.now());
}

/**
 * When a refresh token Plaud just handed us over TLS expires, from its own
 * claims. Not verified and never trusted for access; a wrong value only
 * changes when "link again" is shown.
 */
function expOf(jwt: string): number | undefined {
  try {
    const exp = (JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp : undefined;
  } catch {
    return undefined;
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}
