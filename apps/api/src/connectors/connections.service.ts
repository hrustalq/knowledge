import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Connection, Credential, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  connectionKindsFor,
  connectorResourceKey,
  type ConnectionBranchesResponse,
  type ConnectionLinkResult,
  type ConnectionProvider,
  type ConnectionResourcesResponse,
  type ConnectionSummary,
  type ConnectorKind,
  type CreateConnectionLinksRequest,
  type CreateTokenConnectionRequest,
  type ListConnectionsResponse,
  type UpdateConnectionRequest,
} from '@knowledge/contracts';
import { AUTHOR_ID_STUB } from '../activity/actor.js';
import { decryptSecret, parseKey } from '../ai/secret-box.js';
import { slots } from '../ai/secret-slots.js';
import { assertSafeExternalUrl } from '../common/safe-url.js';
import type { Env } from '../config/env.js';
import { FigmaOauthService } from '../embeds/figma-oauth.service.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { identify, listBranches, listResources, type ProbeContext } from './adapters/connection-providers.js';
import { connectionSecret } from './connection-binding.js';
import { ConnectorsService } from './connectors.service.js';
import { CredentialsService } from './credentials.service.js';
import { GithubAppService } from './github/github-app.service.js';
import { GithubBrowseService } from './github/github-browse.service.js';

/** Providers on one fixed host; every other provider needs a `site`. */
const FIXED_HOST: ReadonlySet<ConnectionProvider> = new Set(['github', 'notion', 'google', 'linear', 'figma']);
const DEFAULT_SITE: Partial<Record<ConnectionProvider, string>> = {
  gitlab: 'https://gitlab.com',
  intercom: 'https://api.intercom.io',
};
const WAIT_STEP_MS = 1000;
const WAIT_MAX_MS = 25_000;

/**
 * The workspace's connections (#564): saving and rotating tokens, what a
 * connection can reach, and linking resources to projects as connectors.
 * API-only — every method serves an admin in the connect flow; the worker
 * dials through `ConnectorsService.contextFor` and never needs this.
 */
@Injectable()
export class ConnectionsService {
  private readonly key: Buffer | null;
  private readonly allowPrivate: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    private readonly connectors: ConnectorsService,
    private readonly githubApp: GithubAppService,
    private readonly figmaOauth: FigmaOauthService,
    private readonly browse: GithubBrowseService,
    private readonly credentials: CredentialsService,
  ) {
    this.key = parseKey(config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
    this.allowPrivate = config.get('CONNECTOR_ALLOW_PRIVATE_URLS', { infer: true });
  }

  async list(workspaceId: string): Promise<ListConnectionsResponse> {
    const rows = await this.prisma.connection.findMany({ where: { workspaceId }, include: SUMMARY_INCLUDE, orderBy: { createdAt: 'asc' } });
    const members = await this.members(workspaceId, rows);
    return {
      workspaceId,
      connections: rows.map((r) => toSummary(r, members)),
      methods: { app: this.githubApp.configured, oauth: this.figmaOauth.configured },
      canStoreSecrets: this.key !== null,
    };
  }

  async get(id: string): Promise<ConnectionSummary> {
    const row = await this.prisma.connection.findUnique({ where: { id }, include: SUMMARY_INCLUDE });
    if (!row) throw new NotFoundException(t('error.connection.notFound', { id }));
    return toSummary(row, await this.members(row.workspaceId, [row]));
  }

  /** Which credential owners are still members here — what `ownerLeft` is derived from, on every read. */
  private async members(workspaceId: string, rows: Array<{ credentialRow: { userId: string | null } | null }>): Promise<Set<string>> {
    const owners = [...new Set(rows.map((r) => r.credentialRow?.userId).filter((u): u is string => Boolean(u)))];
    if (!owners.length) return new Set();
    const found = await this.prisma.workspaceMember.findMany({ where: { workspaceId, userId: { in: owners } }, select: { userId: true } });
    // The AUTH_MODE=none principal has no membership row and is everyone's.
    return new Set([...found.map((m) => m.userId), AUTHOR_ID_STUB]);
  }

  /**
   * Connects the workspace to an account: a pasted token, asked upstream
   * whose it is and kept as the caller's credential (#857), or one of the
   * caller's credentials. The same account already connected here moves onto
   * it, and every connector on that connection dials with it from its next call.
   */
  async saveToken(input: CreateTokenConnectionRequest, userId: string | null): Promise<ConnectionSummary> {
    if (input.credentialId) {
      if (input.credential) throw new BadRequestException(t('error.credential.oneOf'));
      return this.bind(input.workspaceId, input.provider, input.site ?? null, input.credentialId, userId);
    }
    if (!input.credential) throw new BadRequestException(t('error.credential.oneOf'));
    const site = await this.siteFor(input.provider, input.site ?? null);
    const account = await this.probe(input.provider, site, input.credential);
    this.assertKey();
    const credential = await this.credentials.saveToken(userId, input.provider, site, input.credential, account);
    return this.attach(input.workspaceId, credential, site, userId);
  }

  /**
   * One of the caller's own credentials, used here with no trip to the
   * provider. Nobody else's: the owner is the only one who may bind it (403).
   * An Atlassian credential names no site, so it is probed on the one asked for.
   */
  private async bind(workspaceId: string, provider: ConnectionProvider, rawSite: string | null, id: string, userId: string | null): Promise<ConnectionSummary> {
    const credential = await this.credentials.requireOwn(id, userId ?? '');
    this.credentials.assertBindable(credential);
    if (credential.provider !== provider) throw new BadRequestException(t('error.connector.connectionMismatch', { provider: credential.provider }));
    if (credential.method === 'oauth') {
      // A Figma sign-in: the workspace's `oauth` connection is keyed by the Figma account.
      const ref = { workspaceId, provider, method: 'oauth', externalRef: credential.accountId ?? '' };
      const account = { accountId: credential.accountId, accountLabel: credential.accountLabel, credentialId: credential.id };
      const row = await this.prisma.connection.upsert({
        where: { workspaceId_provider_method_externalRef: ref },
        create: { ...ref, ...account, createdBy: userId },
        update: account,
      });
      return this.get(row.id);
    }
    const site = credential.site ?? (FIXED_HOST.has(provider) ? null : await this.siteFor(provider, rawSite));
    await this.probeAt(credential, site);
    return this.attach(workspaceId, credential, site, userId);
  }

  /** An Atlassian credential names no site: it is probed on the one it is about to be used on. */
  private async probeAt(credential: Credential, site: string | null): Promise<void> {
    if (credential.site === null && site) await this.probe(credential.provider as ConnectionProvider, site, decryptSecret(credential.secret, this.key, slots.credential(credential, 'secret')) ?? '');
  }

  /** Points the workspace's connection for this account (or this credential) at it, or creates one. */
  private async attach(workspaceId: string, credential: Credential, site: string | null, userId: string | null): Promise<ConnectionSummary> {
    const existing = await this.prisma.connection.findFirst({
      where: {
        workspaceId,
        provider: credential.provider,
        site,
        method: 'token',
        OR: [{ credentialId: credential.id }, ...(credential.accountId ? [{ accountId: credential.accountId }] : [])],
      },
      orderBy: { createdAt: 'asc' },
    });
    const data = onCredential(credential);
    const row = existing
      ? await this.prisma.connection.update({ where: { id: existing.id }, data })
      : await this.prisma.connection.create({
          data: { workspaceId, provider: credential.provider, site, method: 'token', createdBy: userId, ...data },
        });
    return this.get(row.id);
  }

  /**
   * PATCH: the owner's new token rotates their credential everywhere it is
   * used; anyone else's token, or one of their own credentials, moves this
   * connection onto the caller's sign-in. A token for another account is
   * refused: it would silently move every connector on it.
   */
  async rotate(id: string, input: UpdateConnectionRequest, userId: string | null): Promise<ConnectionSummary> {
    const row = await this.require(id);
    if (row.method !== 'token') throw new BadRequestException(t('error.connection.notToken'));
    if (Boolean(input.credential) === Boolean(input.credentialId)) throw new BadRequestException(t('error.credential.oneOf'));
    if (input.credentialId) {
      const credential = await this.credentials.requireOwn(input.credentialId, userId ?? '');
      if (credential.provider !== row.provider || credential.method !== 'token' || (credential.site !== null && credential.site !== row.site)) {
        throw new BadRequestException(t('error.connector.connectionMismatch', { provider: credential.provider }));
      }
      await this.probeAt(credential, row.site);
      await this.prisma.connection.update({ where: { id }, data: onCredential(credential) });
      return this.get(id);
    }
    const secret = input.credential!;
    const account = await this.probe(row.provider as ConnectionProvider, row.site, secret);
    if (row.accountId && account && account.id !== row.accountId) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.connection.otherAccount', { account: account.label, expected: row.accountLabel ?? row.accountId }),
      });
    }
    const current = row.credentialId ? await this.prisma.credential.findUnique({ where: { id: row.credentialId } }) : null;
    if (current && userId && current.userId === userId) {
      await this.credentials.rotate(current, secret, account);
      return this.get(id);
    }
    this.assertKey();
    const credential = await this.credentials.saveToken(userId, row.provider as ConnectionProvider, row.site, secret, account);
    await this.prisma.connection.update({ where: { id }, data: onCredential(credential) });
    return this.get(id);
  }

  /**
   * The Connected accounts page's Rotate (#857): a new token for the same
   * account, in every workspace using it. Probed on its own host, or on a
   * site one of its connections reaches when it has none (Atlassian).
   */
  async rotateCredential(id: string, secret: string, userId: string) {
    const row = await this.credentials.requireOwn(id, userId);
    let site = row.site;
    if (site === null && !FIXED_HOST.has(row.provider as ConnectionProvider)) {
      const used = await this.prisma.connection.findFirst({ where: { credentialId: id, site: { not: null } }, select: { site: true } });
      site = used?.site ?? null;
      if (!site) throw new BadRequestException(t('error.connection.siteRequired'));
    }
    const account = await this.probe(row.provider as ConnectionProvider, site, secret);
    await this.credentials.rotate(row, secret, account);
    return this.credentials.get(id, userId);
  }

  /** Refused while connectors dial through it — they would be left with nothing. */
  async remove(id: string): Promise<void> {
    const row = await this.require(id);
    const users = await this.prisma.connector.findMany({ where: { connectionId: id }, select: { name: true }, orderBy: { name: 'asc' } });
    if (users.length) {
      const connectors = users.map((c) => c.name);
      throw new ConflictException({
        statusCode: 409,
        message: t('error.connection.inUse', { connectors: connectors.join(', ') }),
        connectors,
      });
    }
    await this.prisma.connection.delete({ where: { id: row.id } });
  }

  /**
   * Changes when the workspace's connections, its App installations or the
   * caller's credentials change — everything an OAuth or App round trip
   * in another tab can write.
   */
  async fingerprint(workspaceId: string, userId: string | null): Promise<string> {
    const [connections, installations, credentials] = await Promise.all([
      this.prisma.connection.findMany({ where: { workspaceId }, select: { id: true, updatedAt: true }, orderBy: { id: 'asc' } }),
      this.prisma.githubInstallation.findMany({ where: { workspaceId }, select: { id: true, updatedAt: true }, orderBy: { id: 'asc' } }),
      // The caller's sign-ins (#857): a GitHub or Figma round trip lands here.
      userId ? this.prisma.credential.findMany({ where: { userId }, select: { id: true, updatedAt: true }, orderBy: { id: 'asc' } }) : [],
    ]);
    const parts = [...connections, ...installations, ...credentials].map((r) => `${r.id}@${r.updatedAt.getTime()}`);
    return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
  }

  /** Long poll: answers once the fingerprint moves off `since`, or after ~25 s, or when the client goes away. */
  async wait(
    workspaceId: string,
    userId: string | null,
    since: string | undefined,
    signal: AbortSignal,
    timing = { stepMs: WAIT_STEP_MS, maxMs: WAIT_MAX_MS },
  ): Promise<{ fingerprint: string; changed: boolean }> {
    const deadline = Date.now() + timing.maxMs;
    for (;;) {
      const fingerprint = await this.fingerprint(workspaceId, userId);
      if (!since || fingerprint !== since) return { fingerprint, changed: Boolean(since) };
      if (signal.aborted || Date.now() + timing.stepMs > deadline) return { fingerprint, changed: false };
      await new Promise((resolve) => setTimeout(resolve, timing.stepMs));
    }
  }

  async resources(id: string, kind: ConnectorKind, q: string, userId: string): Promise<ConnectionResourcesResponse> {
    const row = await this.requireForKind(id, kind);
    try {
      if (row.method === 'app') {
        const listed = await this.browse.repositories(row.workspaceId, userId, row.externalRef ?? '', q, 200);
        return {
          listable: true,
          error: listed.ok ? null : (listed.error ?? null),
          resources: listed.repositories.map((r) => ({
            id: r.fullName,
            label: r.fullName,
            description: r.description,
            namespace: r.ownerLogin,
            private: r.private,
            defaultBranch: r.defaultBranch,
            updatedAt: r.pushedAt,
            url: r.htmlUrl,
            config: { repoUrl: r.htmlUrl },
          })),
        };
      }
      if (row.method !== 'token') return { listable: false, resources: [], error: null };
      const resources = await listResources(row.provider as ConnectionProvider, kind, row.site, await this.probeContext(row), q);
      return { listable: resources !== null, resources: resources ?? [], error: null };
    } catch (err) {
      return { listable: true, resources: [], error: (err as Error).message.slice(0, 300) };
    }
  }

  async branches(id: string, repo: string, userId: string): Promise<ConnectionBranchesResponse> {
    const row = await this.require(id);
    try {
      if (row.method === 'app') {
        const [owner, name] = repo.split('/');
        const listed = await this.browse.branches(row.workspaceId, userId, row.externalRef ?? '', owner ?? '', name ?? '');
        return { branches: listed.branches, error: listed.ok ? null : (listed.error ?? null) };
      }
      return { branches: await listBranches(row.provider as ConnectionProvider, row.site, await this.probeContext(row), repo), error: null };
    } catch (err) {
      return { branches: [], error: (err as Error).message.slice(0, 300) };
    }
  }

  /**
   * One connector per resource↔project pair, each through this connection.
   * A pair already linked — the same kind, resource (and folder) and project —
   * is reported with its connector rather than created twice. Never deletes.
   */
  async link(id: string, input: CreateConnectionLinksRequest, userId: string | null): Promise<ConnectionLinkResult[]> {
    const row = await this.require(id);
    const [existing, projects] = await Promise.all([
      this.prisma.connector.findMany({
        where: { workspaceId: row.workspaceId },
        select: { id: true, kind: true, projectId: true, config: true, name: true },
      }),
      this.prisma.project.findMany({ where: { workspaceId: row.workspaceId }, select: { id: true, name: true } }),
    ]);
    const linked = new Map(existing.map((c) => [`${c.projectId}\n${connectorResourceKey(c.kind as ConnectorKind, c.config as Record<string, unknown>)}`, c.id]));
    const names = new Set(existing.map((c) => c.name));
    const projectName = new Map(projects.map((p) => [p.id, p.name]));

    const results: ConnectionLinkResult[] = [];
    for (const pair of input.links) {
      const result: ConnectionLinkResult = { kind: pair.kind, projectId: pair.projectId, label: pair.label, connectorId: null, status: 'failed', error: null };
      results.push(result);
      const key = `${pair.projectId}\n${connectorResourceKey(pair.kind, pair.config)}`;
      const already = linked.get(key);
      if (already) {
        Object.assign(result, { connectorId: already, status: 'exists' });
        continue;
      }
      if (!connectionKindsFor(row.provider as ConnectionProvider).includes(pair.kind)) {
        result.error = t('error.connector.connectionMismatch', { provider: row.provider });
        continue;
      }
      const base = `${pair.label} · ${projectName.get(pair.projectId) ?? pair.projectId}`.slice(0, 110);
      let name = base;
      for (let n = 2; names.has(name); n += 1) name = `${base} (${n})`;
      try {
        const connector = await this.connectors.create(
          { workspaceId: row.workspaceId, kind: pair.kind, name, projectId: pair.projectId, config: { ...pair.config }, connectionId: row.id },
          userId ?? undefined,
          userId ? (installationId) => this.browse.reaches(userId, installationId) : undefined,
        );
        names.add(name);
        linked.set(key, connector.id);
        Object.assign(result, { connectorId: connector.id, status: 'created' });
      } catch (err) {
        result.error = (err as Error).message.slice(0, 300);
      }
    }
    return results;
  }

  // --- internals ---

  async require(id: string): Promise<Connection> {
    const row = await this.prisma.connection.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(t('error.connection.notFound', { id }));
    return row;
  }

  private async requireForKind(id: string, kind: ConnectorKind): Promise<Connection> {
    const row = await this.require(id);
    if (!connectionKindsFor(row.provider as ConnectionProvider).includes(kind)) {
      throw new BadRequestException(t('error.connector.connectionMismatch', { provider: row.provider }));
    }
    return row;
  }

  /** An origin, SSRF-checked, for providers that are not one fixed host. */
  private async siteFor(provider: ConnectionProvider, raw: string | null): Promise<string | null> {
    if (FIXED_HOST.has(provider)) return null;
    const value = raw?.trim() || DEFAULT_SITE[provider];
    if (!value) throw new BadRequestException(t('error.connection.siteRequired'));
    let origin: string;
    try {
      origin = new URL(value).origin.toLowerCase();
    } catch {
      throw new BadRequestException(t('error.connector.urlInvalid'));
    }
    await assertSafeExternalUrl(origin, this.allowPrivate, {
      invalid: 'error.connector.urlInvalid',
      notHttps: 'error.connector.urlNotHttps',
      unresolved: 'error.connector.hostUnresolved',
      private: 'error.connector.urlPrivate',
    });
    return origin;
  }

  /** Who the token is; a token upstream refuses is never stored. */
  private async probe(provider: ConnectionProvider, site: string | null, credential: string) {
    try {
      return await identify(provider, site, { credential, debug: () => undefined, allowPrivate: this.allowPrivate, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new BadRequestException(t('error.connection.refused', { reason: (err as Error).message.slice(0, 300) }));
    }
  }

  private async probeContext(row: Connection): Promise<ProbeContext> {
    return {
      credential: await connectionSecret(this.prisma, row, this.key),
      debug: () => undefined,
      allowPrivate: this.allowPrivate,
      signal: AbortSignal.timeout(20_000),
    };
  }

  /** A pasted secret is sealed where its credential row is chosen; this refuses it first when it could not be. */
  private assertKey(): void {
    if (!this.key) throw new BadRequestException(t('error.connector.encryptionKeyMissing'));
  }
}

const SUMMARY_INCLUDE = {
  connectors: { select: { id: true, name: true, kind: true, projectId: true }, orderBy: { name: 'asc' } },
  credentialRow: { select: { userId: true, secretHint: true } },
} satisfies Prisma.ConnectionInclude;

/** What a connection holds once it dials with `credential`. */
function onCredential(credential: Credential) {
  return {
    credentialId: credential.id,
    accountId: credential.accountId,
    accountLabel: credential.accountLabel,
    accountAvatarUrl: credential.accountAvatarUrl,
  };
}

function toSummary(
  row: Connection & {
    connectors: Array<{ id: string; name: string; kind: string; projectId: string }>;
    credentialRow: { userId: string | null; secretHint: string | null } | null;
  },
  members: Set<string>,
): ConnectionSummary {
  const ownerId = row.credentialRow?.userId ?? null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    provider: row.provider as ConnectionSummary['provider'],
    method: row.method as ConnectionSummary['method'],
    site: row.site,
    accountId: row.accountId,
    accountLabel: row.accountLabel,
    accountAvatarUrl: row.accountAvatarUrl,
    credentialHint: row.credentialRow?.secretHint ?? null,
    credentialId: row.credentialId,
    ownerId,
    ownerLeft: row.credentialId !== null && (ownerId === null || !members.has(ownerId)),
    connectors: row.connectors.map((c) => ({ ...c, kind: c.kind as ConnectorKind })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
