import type { Connection, Connector, Credential, Prisma, PrismaClient } from '@prisma/client';
import {
  connectionProviderFor,
  credentialSiteFor,
  FIGMA_GRANT_CONFIG_KEY,
  FIGMA_HANDLE_CONFIG_KEY,
  GITHUB_INSTALLATION_CONFIG_KEY,
  type ConnectionMethod,
  type ConnectionProvider,
  type ConnectorKind,
} from '@knowledge/contracts';
import { decryptSecret, maskSecret } from '../ai/secret-box.js';
import type { ProviderAccount } from './adapters/connection-providers.js';

type Db = Pick<PrismaClient, 'connection' | 'connector' | 'githubInstallation' | 'credential'>;
export type BindableConnector = Pick<Connector, 'id' | 'workspaceId' | 'kind' | 'config' | 'createdBy'>;
/** A pasted token, in plaintext to match by and sealed to store. */
export interface ConnectorToken {
  secret: string;
  envelope: string;
}

/**
 * Points a connector at the connection its own settings imply (#564): the
 * GitHub App installation or Figma sign-in in its config, else `token`, the
 * secret it dials with. An equal connection in the same workspace is reused
 * before one is created, so connectors that share a token share one
 * connection — compared decrypted, because two envelopes of one secret never
 * match byte for byte.
 *
 * Every write that changes how a connector authenticates goes through here,
 * when it was not handed a connection. Null for a connector with nothing to
 * authenticate with (a public repository).
 */
export async function bindConnection(db: Db, row: BindableConnector, key: Buffer | null, token: ConnectorToken | null): Promise<string | null> {
  const connectionId = await connectionFor(db, row, key, token);
  await db.connector.update({ where: { id: row.id }, data: { connectionId } });
  return connectionId;
}

async function connectionFor(db: Db, row: BindableConnector, key: Buffer | null, token: ConnectorToken | null): Promise<string | null> {
  const config = (row.config ?? {}) as Record<string, unknown>;
  const installation = text(config[GITHUB_INSTALLATION_CONFIG_KEY]);
  if (installation && /^\d+$/.test(installation)) {
    const account = await db.githubInstallation.findUnique({
      where: { workspaceId_installationId: { workspaceId: row.workspaceId, installationId: BigInt(installation) } },
    });
    return byRef(db, row, 'github', 'app', installation, {
      accountId: installation,
      accountLabel: account?.accountLogin ?? null,
      accountAvatarUrl: account?.accountAvatarUrl ?? null,
    });
  }
  const grant = row.kind === 'figma' ? text(config[FIGMA_GRANT_CONFIG_KEY]) : null;
  if (grant) {
    return byRef(db, row, 'figma', 'oauth', grant, { accountId: grant, accountLabel: text(config[FIGMA_HANDLE_CONFIG_KEY]) });
  }

  if (!token) return null;
  const { secret, envelope } = token;
  const { provider, site } = connectionProviderFor(row.kind as ConnectorKind, config);
  const tokens = await db.connection.findMany({
    where: { workspaceId: row.workspaceId, provider, site, method: 'token' },
    include: { credentialRow: { select: { secret: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const same = tokens.find((c) => decryptSecret(c.credentialRow?.secret, key) === secret);
  if (same) return same.id;
  const credential = await tokenCredential(
    db,
    { userId: row.createdBy, provider, site, envelope, secret, hint: maskSecret(secret), account: null },
    key,
  );
  const created = await db.connection.create({
    data: {
      workspaceId: row.workspaceId,
      provider,
      site,
      method: 'token',
      credentialId: credential.id,
      accountId: credential.accountId,
      accountLabel: credential.accountLabel,
      accountAvatarUrl: credential.accountAvatarUrl,
      createdBy: row.createdBy,
    },
  });
  return created.id;
}

/** An installation or grant is one connection per workspace — the unique key makes this a single upsert. */
async function byRef(
  db: Db,
  row: BindableConnector,
  provider: ConnectionProvider,
  method: ConnectionMethod,
  externalRef: string,
  account: Pick<Prisma.ConnectionCreateInput, 'accountId' | 'accountLabel' | 'accountAvatarUrl'>,
): Promise<string> {
  const { id } = await db.connection.upsert({
    where: { workspaceId_provider_method_externalRef: { workspaceId: row.workspaceId, provider, method, externalRef } },
    create: { workspaceId: row.workspaceId, provider, method, externalRef, site: null, ...account, createdBy: row.createdBy },
    update: {},
    select: { id: true },
  });
  return id;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export interface TokenCredentialInput {
  userId: string | null;
  provider: string;
  /** The connection's site; `credentialSiteFor` decides what the credential keeps. */
  site: string | null;
  /** The secret-box envelope to store, and its plaintext to match by. */
  envelope: string;
  secret: string;
  hint: string | null;
  account: ProviderAccount | null;
}

/**
 * One owner's credential for a pasted secret (#857): the same secret for the
 * same provider and host is the same row, compared decrypted because two
 * envelopes of one secret never match. Never matched by account — two
 * fine-grained tokens for one account reach different repositories. The one
 * matcher for `bindConnection` and the connect dialog.
 */
export async function tokenCredential(db: Pick<PrismaClient, 'credential'>, input: TokenCredentialInput, key: Buffer | null): Promise<Credential> {
  const site = credentialSiteFor(input.provider as ConnectionProvider, input.site);
  const mine = await db.credential.findMany({
    where: { userId: input.userId, provider: input.provider, method: 'token', site },
    orderBy: { createdAt: 'asc' },
  });
  const same = mine.find((c) => decryptSecret(c.secret, key) === input.secret);
  const account = input.account
    ? { accountId: input.account.id, accountLabel: input.account.label, accountAvatarUrl: input.account.avatarUrl }
    : {};
  if (same) return input.account ? db.credential.update({ where: { id: same.id }, data: account }) : same;
  return db.credential.create({
    data: {
      userId: input.userId,
      provider: input.provider,
      method: 'token',
      site,
      ...account,
      secret: input.envelope,
      secretHint: input.hint,
    },
  });
}

/** What a token connection dials with (#857): its credential's secret. */
export async function connectionSecret(
  db: Pick<PrismaClient, 'credential'>,
  connection: Pick<Connection, 'credentialId'>,
  key: Buffer | null,
): Promise<string | null> {
  if (!connection.credentialId) return null;
  const row = await db.credential.findUnique({ where: { id: connection.credentialId }, select: { secret: true } });
  return decryptSecret(row?.secret, key);
}
