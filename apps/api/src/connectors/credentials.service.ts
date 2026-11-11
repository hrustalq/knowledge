import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Credential } from '@prisma/client';
import {
  CONNECTION_PROVIDERS,
  credentialBindable,
  type ConnectionMethod,
  type ConnectionProvider,
  type CredentialSummary,
} from '@knowledge/contracts';
import { encryptSecret, maskSecret, parseKey } from '../ai/secret-box.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ProviderAccount } from './adapters/connection-providers.js';
import { tokenCredential } from './connection-binding.js';

/**
 * A person's credentials (#857): reading the secret a connection dials with,
 * pasted tokens, rotation, the Connected accounts page, and the owner check
 * every bind passes. GitHub and Figma sign-ins are written by their OAuth
 * services, whose refresh is provider-specific, into the same rows; a sync
 * reads the secret through `connectionSecret`. API-only.
 */
@Injectable()
export class CredentialsService {
  private readonly key: Buffer | null;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.key = parseKey(config.get('SETTINGS_ENCRYPTION_KEY', { infer: true }));
  }

  /** The caller's credential for a pasted secret, reused when they pasted it before. The caller encrypts. */
  saveToken(userId: string | null, provider: ConnectionProvider, site: string | null, secret: string, envelope: string, account: ProviderAccount | null) {
    return tokenCredential(this.prisma, { userId, provider, site, secret, envelope, hint: maskSecret(secret), account }, this.key);
  }

  /** The caller's own credential, or 403 — nobody else's is ever bound, rotated or shown. */
  async requireOwn(id: string, userId: string): Promise<Credential> {
    const row = await this.prisma.credential.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(t('error.credential.notFound', { id }));
    if (row.userId !== userId) throw new ForbiddenException(t('error.credential.notYours'));
    return row;
  }

  /** A credential a workspace connection may dial with; a GitHub sign-in is only for browsing. */
  assertBindable(row: Pick<Credential, 'provider' | 'method'>): void {
    if (!credentialBindable(row.provider as ConnectionProvider, row.method as ConnectionMethod)) {
      throw new ConflictException({ statusCode: 409, message: t('error.credential.notBindable') });
    }
  }

  /** A new secret for the same account, in every workspace using it, since each connection reads it live. The caller probed it. */
  async rotate(row: Credential, secret: string, account: ProviderAccount | null): Promise<Credential> {
    if (row.method !== 'token') throw new ConflictException({ statusCode: 409, message: t('error.connection.notToken') });
    if (row.accountId && account && account.id !== row.accountId) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.connection.otherAccount', { account: account.label, expected: row.accountLabel ?? row.accountId }),
      });
    }
    return this.prisma.credential.update({
      where: { id: row.id },
      data: {
        secret: encryptSecret(secret, this.key),
        secretHint: maskSecret(secret),
        ...(account ? { accountId: account.id, accountLabel: account.label, accountAvatarUrl: account.avatarUrl } : {}),
      },
    });
  }

  async list(userId: string): Promise<CredentialSummary[]> {
    // A sign-in that backs no connector (Plaud, #864) is shown where it is used, not here.
    const rows = await this.prisma.credential.findMany({ where: { userId, provider: { in: [...CONNECTION_PROVIDERS] } }, orderBy: [{ provider: 'asc' }, { createdAt: 'asc' }] });
    const usage = await this.usage(rows.map((r) => r.id));
    return rows.map((r) => toCredentialSummary(r, usage.get(r.id) ?? []));
  }

  async get(id: string, userId: string): Promise<CredentialSummary> {
    const row = await this.requireOwn(id, userId);
    return toCredentialSummary(row, (await this.usage([id])).get(id) ?? []);
  }

  /** Disconnect. Refused while a connection dials with it, naming where — the same rule as a connection in use. */
  async remove(id: string, userId: string): Promise<void> {
    await this.requireOwn(id, userId);
    const usedBy = (await this.usage([id])).get(id) ?? [];
    if (usedBy.length) {
      const workspaces = [...new Set(usedBy.map((u) => u.workspaceName))];
      throw new ConflictException({
        statusCode: 409,
        message: t('error.credential.inUse', { workspaces: workspaces.join(', ') }),
        workspaces,
        connectors: usedBy.flatMap((u) => u.connectors),
      });
    }
    await this.prisma.credential.delete({ where: { id } });
  }

  private async usage(ids: string[]): Promise<Map<string, CredentialSummary['usedBy']>> {
    const out = new Map<string, CredentialSummary['usedBy']>();
    if (!ids.length) return out;
    const connections = await this.prisma.connection.findMany({
      where: { credentialId: { in: ids } },
      select: { id: true, workspaceId: true, credentialId: true, connectors: { select: { name: true }, orderBy: { name: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    });
    const workspaces = await this.prisma.workspace.findMany({
      where: { id: { in: [...new Set(connections.map((c) => c.workspaceId))] } },
      select: { id: true, name: true },
    });
    const names = new Map(workspaces.map((w) => [w.id, w.name]));
    for (const c of connections) {
      // A workspace being torn down still counts: its connections hold the credential until they go.
      const workspaceName = names.get(c.workspaceId) ?? c.workspaceId;
      const list = out.get(c.credentialId!) ?? [];
      list.push({ workspaceId: c.workspaceId, workspaceName, connectionId: c.id, connectors: c.connectors.map((n) => n.name) });
      out.set(c.credentialId!, list);
    }
    return out;
  }
}

export function toCredentialSummary(row: Credential, usedBy: CredentialSummary['usedBy']): CredentialSummary {
  return {
    id: row.id,
    provider: row.provider as ConnectionProvider,
    method: row.method as ConnectionMethod,
    site: row.site,
    accountId: row.accountId,
    accountLabel: row.accountLabel,
    accountAvatarUrl: row.accountAvatarUrl,
    secretHint: row.secretHint,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    bindable: credentialBindable(row.provider as ConnectionProvider, row.method as ConnectionMethod),
    usedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
