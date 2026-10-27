import type { Connector, Prisma, PrismaClient } from '@prisma/client';
import {
  connectionProviderFor,
  FIGMA_GRANT_CONFIG_KEY,
  FIGMA_HANDLE_CONFIG_KEY,
  GITHUB_INSTALLATION_CONFIG_KEY,
  type ConnectionMethod,
  type ConnectionProvider,
  type ConnectorKind,
} from '@knowledge/contracts';
import { decryptSecret } from '../ai/secret-box.js';

type Db = Pick<PrismaClient, 'connection' | 'connector' | 'githubInstallation'>;
export type BindableConnector = Pick<
  Connector,
  'id' | 'workspaceId' | 'kind' | 'config' | 'credential' | 'credentialHint' | 'createdBy'
>;

/**
 * Points a connector at the connection its own settings imply (#564): the
 * GitHub App installation or Figma grant in its config, else its pasted token.
 * An equal connection in the same workspace is reused before one is created,
 * so connectors that share a token share one connection — compared decrypted,
 * because two envelopes of one secret never match byte for byte.
 *
 * The one writer of `connectors.connection_id` while the inline credential is
 * still the source of truth: the API boot backfill, and every write that
 * changes how a connector authenticates. Null for a connector with nothing to
 * authenticate with (a public repository), or a token that cannot be read.
 */
export async function bindConnection(db: Db, row: BindableConnector, key: Buffer | null): Promise<string | null> {
  const connectionId = await connectionFor(db, row, key);
  await db.connector.update({ where: { id: row.id }, data: { connectionId } });
  return connectionId;
}

async function connectionFor(db: Db, row: BindableConnector, key: Buffer | null): Promise<string | null> {
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

  const secret = decryptSecret(row.credential, key);
  if (!secret) return null;
  const { provider, site } = connectionProviderFor(row.kind as ConnectorKind, config);
  const tokens = await db.connection.findMany({
    where: { workspaceId: row.workspaceId, provider, site, method: 'token' },
    orderBy: { createdAt: 'asc' },
  });
  const same = tokens.find((c) => decryptSecret(c.credential, key) === secret);
  if (same) return same.id;
  const created = await db.connection.create({
    data: {
      workspaceId: row.workspaceId,
      provider,
      site,
      method: 'token',
      // The connector's own envelope: the same key sealed it, so no re-encrypt.
      credential: row.credential,
      credentialHint: row.credentialHint,
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
