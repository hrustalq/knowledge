import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { connectionProviderFor } from '@knowledge/contracts';
import { encryptSecret } from '../src/ai/secret-box.js';
import { slots } from '../src/ai/secret-slots.js';
import { bindConnection, type BindableConnector } from '../src/connectors/connection-binding.js';
import { ConnectorsService } from '../src/connectors/connectors.service.js';

/**
 * Connections (#564, phase 1): which provider a connector authenticates
 * against, binding connectors to shared connections, and dialing through them.
 */
const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const key = randomBytes(32);
const keyText = key.toString('base64');

interface Conn {
  id: string;
  workspaceId: string;
  provider: string;
  method: string;
  site: string | null;
  externalRef: string | null;
  credentialId?: string | null;
  createdAt: Date;
  [k: string]: unknown;
}
type Row = BindableConnector & { connectionId: string | null; createdAt: Date; token: string | null };

/** Just enough of Prisma for the binding, over two arrays. */
function fakeDb(connectors: Row[]) {
  const connections: Conn[] = [];
  const matches = (c: Conn, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (c as Record<string, unknown>)[k] === v);
  const db = {
    connections,
    connectors,
    connection: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        connections.filter((c) => matches(c, where)).map((c) => ({ ...c, credentialRow: db.credentials.find((r) => r.id === c.credentialId) ?? null })),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => connections.find((c) => c.id === where.id) ?? null),
      create: vi.fn(async ({ data }: { data: Omit<Conn, 'id' | 'createdAt'> }) => {
        const row = { externalRef: null, site: null, ...data, id: randomUUID(), createdAt: new Date() } as Conn;
        connections.push(row);
        return row;
      }),
      upsert: vi.fn(async ({ where, create }: { where: Record<string, Record<string, unknown>>; create: Omit<Conn, 'id' | 'createdAt'> }) => {
        const found = connections.find((c) => matches(c, Object.values(where)[0]));
        return found ?? db.connection.create({ data: create });
      }),
    },
    connector: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = connectors.find((c) => c.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
    githubInstallation: {
      findUnique: vi.fn(async () => ({ accountLogin: 'acme', accountAvatarUrl: null })),
    },
    // A new token connection gets its owner's credential (#857); its own spec covers the matching.
    credentials: [] as Array<{ id: string; secret: string; accountId: null; accountLabel: null; accountAvatarUrl: null }>,
    credential: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: { secret: string } }) => {
        const row = { id: randomUUID(), ...data, accountId: null, accountLabel: null, accountAvatarUrl: null };
        db.credentials.push(row);
        return row;
      }),
    },
  };
  return db;
}

function connector(over: Partial<Row> & { token?: string }): Row {
  const { token, ...rest } = over;
  return {
    id: randomUUID(),
    workspaceId: WS,
    kind: 'markdown-git',
    config: { repoUrl: 'https://github.com/acme/runbooks' },
    token: token ?? null,
    createdBy: null,
    connectionId: null,
    createdAt: new Date(),
    ...rest,
  };
}

/** Binds each connector as `ConnectorsService.create` does, with the token it was given. */
const bindAll = async (db: ReturnType<typeof fakeDb>) => {
  for (const row of db.connectors) {
    await bindConnection(db as never, row, key, row.token ? { secret: row.token } : null);
  }
};

describe('connectionProviderFor', () => {
  it('derives the provider from the kind, and the host for git kinds', () => {
    expect(connectionProviderFor('codebase', { repoUrl: 'https://github.com/acme/api' })).toEqual({ provider: 'github', site: null });
    expect(connectionProviderFor('markdown-git', { repoUrl: 'https://gitlab.com/g/sub/repo' })).toEqual({
      provider: 'gitlab',
      site: 'https://gitlab.com',
    });
    expect(connectionProviderFor('codebase', { repoUrl: 'https://gitlab.acme.io/team/repo' })).toEqual({
      provider: 'gitlab',
      site: 'https://gitlab.acme.io',
    });
    expect(connectionProviderFor('codebase', { repoUrl: 'https://git.acme.io/team/repo' })).toEqual({
      provider: 'git',
      site: 'https://git.acme.io',
    });
    expect(connectionProviderFor('codebase', { repoUrl: 'not a url' })).toEqual({ provider: 'git', site: null });
  });

  it('puts Confluence Cloud and Jira on one site under one Atlassian provider', () => {
    const wiki = connectionProviderFor('confluence', { baseUrl: 'https://Acme.atlassian.net/wiki' });
    expect(wiki).toEqual({ provider: 'atlassian', site: 'https://acme.atlassian.net' });
    expect(connectionProviderFor('jira', { baseUrl: 'https://acme.atlassian.net' })).toEqual(wiki);
    expect(connectionProviderFor('confluence-server', { baseUrl: 'https://wiki.acme.io' }).provider).toBe('confluence-server');
    expect(connectionProviderFor('google-drive', {})).toEqual({ provider: 'google', site: null });
    expect(connectionProviderFor('figma', {})).toEqual({ provider: 'figma', site: null });
    expect(connectionProviderFor('intercom', { region: 'eu' }).site).toBe('https://api.eu.intercom.io');
    expect(connectionProviderFor('intercom', {}).site).toBe('https://api.intercom.io');
  });
});

describe('bindConnection', () => {
  it('shares one connection between connectors holding the same token, never across workspaces', async () => {
    const a = connector({ token: 'ghp_same' });
    const b = connector({ kind: 'codebase', config: { repoUrl: 'https://github.com/acme/api' }, token: 'ghp_same' });
    const c = connector({ token: 'ghp_other' });
    const d = connector({ workspaceId: OTHER_WS, token: 'ghp_same' });
    const publicRepo = connector({});
    const db = fakeDb([a, b, c, d, publicRepo]);

    await bindAll(db);
    expect(a.connectionId).toBe(b.connectionId);
    expect(c.connectionId).not.toBe(a.connectionId);
    expect(d.connectionId).not.toBe(a.connectionId);
    expect(publicRepo.connectionId).toBeNull();
    expect(db.connections.map((x) => [x.workspaceId, x.provider, x.method])).toEqual([
      [WS, 'github', 'token'],
      [WS, 'github', 'token'],
      [OTHER_WS, 'github', 'token'],
    ]);
    // The secret lives on the credential only (#857).
    expect(db.connections.every((x) => x.credentialId && !('credential' in x))).toBe(true);
  });

  it('turns an installation and a Figma sign-in into one app / oauth connection each', async () => {
    const one = connector({ config: { repoUrl: 'https://github.com/acme/a', githubInstallationId: '42' } });
    const two = connector({ kind: 'codebase', config: { repoUrl: 'https://github.com/acme/b', githubInstallationId: '42' } });
    const figma = connector({ kind: 'figma', config: { figmaGrant: 'fu-1', figmaHandle: 'ann' } });
    const db = fakeDb([one, two, figma]);
    await bindAll(db);

    expect(one.connectionId).toBe(two.connectionId);
    expect(db.connections.map((x) => [x.provider, x.method, x.externalRef, x.accountLabel])).toEqual([
      ['github', 'app', '42', 'acme'],
      ['figma', 'oauth', 'fu-1', 'ann'],
    ]);
  });

  it('rebinds when the token changes, and unbinds when it is cleared', async () => {
    const row = connector({ token: 'ghp_old' });
    const db = fakeDb([row]);
    await bindAll(db);
    const first = row.connectionId;
    await bindConnection(db as never, row, key, { secret: 'ghp_new' });
    expect(row.connectionId).not.toBe(first);
    await bindConnection(db as never, row, key, null);
    expect(row.connectionId).toBeNull();
  });
});

describe('dialing through a connection', () => {
  function service(connection: Partial<Conn>, secret?: string) {
    const prisma = {
      connection: { findUnique: vi.fn(async () => ({ workspaceId: WS, method: 'token', credentialId: 'cred-1', ...connection })) },
      credential: { findUnique: vi.fn(async () => (secret ? { secret: encryptSecret(secret, key, slots.credential({ id: 'cred-1' }, 'secret')) } : null)) },
    };
    const config = { get: (name: string) => (name === 'SETTINGS_ENCRYPTION_KEY' ? keyText : false) };
    const githubApp = { installationToken: vi.fn(async (id: string) => `ghs_for_${id}`) };
    return new ConnectorsService(prisma as never, config as never, {} as never, {} as never, githubApp as never, {} as never);
  }
  const row = (over: Partial<Row> = {}) =>
    ({ ...connector({}), connectionId: 'conn-1', locale: 'en', webhookSecret: null, ...over }) as never;

  it('dials with the connection’s credential, so a rotation reaches every connector on it', async () => {
    const ctx = await service({}, 'ghp_rotated').contextFor(row(), async () => undefined);
    expect(ctx.credential).toBe('ghp_rotated');
  });

  it('mints from the installation of an app connection', async () => {
    const ctx = await service({ method: 'app', externalRef: '42' }).contextFor(row(), async () => undefined);
    expect(ctx.credential).toBe('ghs_for_42');
  });

  it('refuses a connection that belongs to another workspace', async () => {
    await expect(
      service({ workspaceId: OTHER_WS }, 'theirs').contextFor(row(), async () => undefined),
    ).rejects.toThrow(/connectionForeign/);
  });

  it('sends nothing while unbound (a public repository)', async () => {
    const ctx = await service({}, 'unused').contextFor(row({ connectionId: null }), async () => undefined);
    expect(ctx.credential).toBeNull();
  });
});
