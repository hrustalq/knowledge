import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Connection } from '@prisma/client';
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
} from '@knowledge/contracts';
import { decryptSecret, encryptSecret, maskSecret, MissingEncryptionKeyError, parseKey } from '../ai/secret-box.js';
import { assertSafeExternalUrl } from '../common/safe-url.js';
import type { Env } from '../config/env.js';
import { FigmaOauthService, pruneFigmaGrants } from '../embeds/figma-oauth.service.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { identify, listBranches, listResources, type ProbeContext } from './adapters/connection-providers.js';
import { ConnectorsService } from './connectors.service.js';
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
  ) {
    this.key = parseKey(config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
    this.allowPrivate = config.get('CONNECTOR_ALLOW_PRIVATE_URLS', { infer: true });
  }

  async list(workspaceId: string): Promise<ListConnectionsResponse> {
    const rows = await this.prisma.connection.findMany({
      where: { workspaceId },
      include: { connectors: { select: { id: true, name: true, kind: true, projectId: true }, orderBy: { name: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      workspaceId,
      connections: rows.map(toSummary),
      methods: { app: this.githubApp.configured, oauth: this.figmaOauth.configured },
      canStoreSecrets: this.key !== null,
    };
  }

  async get(id: string): Promise<ConnectionSummary> {
    const row = await this.prisma.connection.findUnique({
      where: { id },
      include: { connectors: { select: { id: true, name: true, kind: true, projectId: true }, orderBy: { name: 'asc' } } },
    });
    if (!row) throw new NotFoundException(t('error.connection.notFound', { id }));
    return toSummary(row);
  }

  /**
   * Saves a token after asking upstream whose it is. The same account again
   * is a rotation: the existing connection takes the new token, and every
   * connector on it dials with it from its next call.
   */
  async saveToken(input: CreateTokenConnectionRequest, userId: string | null): Promise<ConnectionSummary> {
    const site = await this.siteFor(input.provider, input.site ?? null);
    const account = await this.probe(input.provider, site, input.credential);
    const existing = account
      ? await this.prisma.connection.findFirst({
          where: { workspaceId: input.workspaceId, provider: input.provider, site, method: 'token', accountId: account.id },
        })
      : null;
    const data = {
      credential: this.encrypt(input.credential),
      credentialHint: maskSecret(input.credential),
      accountId: account?.id ?? null,
      accountLabel: account?.label ?? null,
      accountAvatarUrl: account?.avatarUrl ?? null,
    };
    const row = existing
      ? await this.rotateRow(existing.id, data)
      : await this.prisma.connection.create({
          data: { workspaceId: input.workspaceId, provider: input.provider, site, method: 'token', createdBy: userId, ...data },
        });
    return this.get(row.id);
  }

  /** A new token for the same account. Another account's token is refused: it would silently move every connector on it. */
  async rotate(id: string, credential: string): Promise<ConnectionSummary> {
    const row = await this.require(id);
    if (row.method !== 'token') throw new BadRequestException(t('error.connection.notToken'));
    const account = await this.probe(row.provider as ConnectionProvider, row.site, credential);
    if (row.accountId && account && account.id !== row.accountId) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.connection.otherAccount', { account: account.label, expected: row.accountLabel ?? row.accountId }),
      });
    }
    await this.rotateRow(id, {
      credential: this.encrypt(credential),
      credentialHint: maskSecret(credential),
      accountId: account?.id ?? row.accountId,
      accountLabel: account?.label ?? row.accountLabel,
      accountAvatarUrl: account?.avatarUrl ?? row.accountAvatarUrl,
    });
    return this.get(id);
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
    // A Figma grant nothing references any more goes with its last connection.
    if (row.method === 'oauth') await pruneFigmaGrants(this.prisma);
  }

  /**
   * Changes when the workspace's connections, its App installations or the
   * caller's GitHub identity change — everything an OAuth or App round trip
   * in another tab can write.
   */
  async fingerprint(workspaceId: string, userId: string | null): Promise<string> {
    const [connections, installations, identity] = await Promise.all([
      this.prisma.connection.findMany({ where: { workspaceId }, select: { id: true, updatedAt: true }, orderBy: { id: 'asc' } }),
      this.prisma.githubInstallation.findMany({ where: { workspaceId }, select: { id: true, updatedAt: true }, orderBy: { id: 'asc' } }),
      userId ? this.prisma.githubUserToken.findUnique({ where: { userId }, select: { updatedAt: true } }) : null,
    ]);
    const parts = [...connections, ...installations].map((r) => `${r.id}@${r.updatedAt.getTime()}`);
    parts.push(`gh@${identity?.updatedAt.getTime() ?? 0}`);
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
      const resources = await listResources(row.provider as ConnectionProvider, kind, row.site, this.probeContext(row), q);
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
      return { branches: await listBranches(row.provider as ConnectionProvider, row.site, this.probeContext(row), repo), error: null };
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

  /** The new token lands on the connection and on the inline copies its connectors keep for a rollback. */
  private async rotateRow(id: string, data: { credential: string; credentialHint: string } & Record<string, string | null>) {
    const [row] = await this.prisma.$transaction([
      this.prisma.connection.update({ where: { id }, data }),
      this.prisma.connector.updateMany({ where: { connectionId: id }, data: { credential: data.credential, credentialHint: data.credentialHint } }),
    ]);
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

  private probeContext(row: Connection): ProbeContext {
    return {
      credential: decryptSecret(row.credential, this.key),
      debug: () => undefined,
      allowPrivate: this.allowPrivate,
      signal: AbortSignal.timeout(20_000),
    };
  }

  private encrypt(plaintext: string): string {
    try {
      return encryptSecret(plaintext, this.key);
    } catch (err) {
      if (err instanceof MissingEncryptionKeyError) throw new BadRequestException(t('error.connector.encryptionKeyMissing'));
      throw err;
    }
  }
}

function toSummary(
  row: Connection & { connectors: Array<{ id: string; name: string; kind: string; projectId: string }> },
): ConnectionSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    provider: row.provider as ConnectionSummary['provider'],
    method: row.method as ConnectionSummary['method'],
    site: row.site,
    accountId: row.accountId,
    accountLabel: row.accountLabel,
    accountAvatarUrl: row.accountAvatarUrl,
    credentialHint: row.credentialHint,
    connectors: row.connectors.map((c) => ({ ...c, kind: c.kind as ConnectorKind })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
