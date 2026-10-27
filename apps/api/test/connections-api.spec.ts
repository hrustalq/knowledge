import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

/**
 * Connections (#564, phase 2): saving and rotating tokens, the in-use delete
 * refusal, the links duplicate rule and the long poll. Upstream is the mocked
 * identify probe; Prisma is a few arrays.
 */
vi.mock('../src/connectors/adapters/connection-providers.js', () => ({
  identify: vi.fn(async (_p: string, _s: string | null, ctx: { credential: string }) => {
    if (ctx.credential.startsWith('bad')) throw new Error('401 Bad credentials');
    const login = ctx.credential.split('_')[1];
    return { id: `id-${login}`, label: login, avatarUrl: null };
  }),
  listResources: vi.fn(),
  listBranches: vi.fn(),
}));
vi.mock('../src/i18n/t.js', () => ({ t: (key: string, args?: object) => `${key} ${JSON.stringify(args ?? {})}` }));
const { ConnectionsService } = await import('../src/connectors/connections.service.js');

const WS = '11111111-1111-4111-8111-111111111111';
const key = randomBytes(32).toString('base64');

function setup() {
  let seq = 0;
  const connections: Array<Record<string, unknown>> = [];
  const connectors: Array<Record<string, unknown>> = [];
  const pick = <T extends Record<string, unknown>>(rows: T[], where: Record<string, unknown>) =>
    rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
  const withConnectors = (c: Record<string, unknown>) => ({ ...c, connectors: pick(connectors, { connectionId: c.id }) });
  const prisma = {
    connection: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => pick(connections, where).map(withConnectors)),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => pick(connections, where)[0] ?? null),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const c = connections.find((r) => r.id === where.id);
        return c ? withConnectors(c) : null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `conn-${++seq}`, createdAt: new Date(), updatedAt: new Date() };
        connections.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(connections.find((r) => r.id === where.id)!, data, { updatedAt: new Date(Date.now() + ++seq) }),
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => connections.splice(connections.findIndex((r) => r.id === where.id), 1)),
    },
    connector: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => pick(connectors, where)),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const rows = pick(connectors, where);
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }),
    },
    project: { findMany: vi.fn(async () => [{ id: 'p1', name: 'Docs' }, { id: 'p2', name: 'Ops' }]) },
    githubInstallation: { findMany: vi.fn(async () => []) },
    githubUserToken: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const create = vi.fn(async (input: Record<string, unknown>) => {
    const row = { id: `c-${++seq}`, ...input };
    connectors.push(row);
    return row;
  });
  const config = { get: (k: string) => (k === 'SETTINGS_ENCRYPTION_KEY' ? key : false) };
  const service = new ConnectionsService(
    prisma as never,
    config as never,
    { create } as never,
    { configured: false } as never,
    { configured: false } as never,
    {} as never,
  );
  return { service, connections, connectors, create, prisma };
}

describe('token connections', () => {
  it('identifies the account, and rotates when the same account is saved again', async () => {
    const { service, connections, connectors } = setup();
    const first = await service.saveToken({ workspaceId: WS, provider: 'github', credential: 'ghp_ann_1' }, null);
    expect(first).toMatchObject({ provider: 'github', site: null, accountLabel: 'ann' });
    connectors.push({ id: 'c1', name: 'Runbooks', connectionId: first.id, credential: 'old' });

    const again = await service.saveToken({ workspaceId: WS, provider: 'github', credential: 'ghp_ann_2' }, null);
    expect(again.id).toBe(first.id);
    expect(connections).toHaveLength(1);
    // The rollback copy follows the rotation.
    expect(connectors[0].credential).toBe(connections[0].credential);

    const other = await service.saveToken({ workspaceId: WS, provider: 'github', credential: 'ghp_bob_1' }, null);
    expect(other.id).not.toBe(first.id);
  });

  it('refuses a token upstream rejects, and a rotation to another account', async () => {
    const { service } = setup();
    await expect(service.saveToken({ workspaceId: WS, provider: 'github', credential: 'bad' }, null)).rejects.toThrow(/connection\.refused/);
    const ann = await service.saveToken({ workspaceId: WS, provider: 'github', credential: 'ghp_ann_1' }, null);
    await expect(service.rotate(ann.id, 'ghp_bob_1')).rejects.toThrow(/otherAccount/);
    await expect(service.rotate(ann.id, 'ghp_ann_9')).resolves.toMatchObject({ accountLabel: 'ann' });
  });

  it('defaults GitLab to gitlab.com and keeps a site for it', async () => {
    const { service } = setup();
    const lab = await service.saveToken({ workspaceId: WS, provider: 'gitlab', credential: 'glpat_ann_1' }, null);
    expect(lab.site).toBe('https://gitlab.com');
  });

  it('refuses to delete a connection connectors still use, naming them', async () => {
    const { service, connectors } = setup();
    const ann = await service.saveToken({ workspaceId: WS, provider: 'github', credential: 'ghp_ann_1' }, null);
    connectors.push({ id: 'c1', name: 'Runbooks', connectionId: ann.id });
    await expect(service.remove(ann.id)).rejects.toMatchObject({ response: { connectors: ['Runbooks'] } });
    connectors.length = 0;
    await expect(service.remove(ann.id)).resolves.toBeUndefined();
  });
});

describe('links', () => {
  it('creates one connector per pair, reports existing pairs and refuses a duplicate in the same request', async () => {
    const { service, create, connectors } = setup();
    const ann = await service.saveToken({ workspaceId: WS, provider: 'github', credential: 'ghp_ann_1' }, null);
    connectors.push({ id: 'old', workspaceId: WS, kind: 'codebase', projectId: 'p1', name: 'acme/api · Docs', config: { repoUrl: 'https://github.com/acme/api.git' } });
    const repo = (subdir = '') => ({ repoUrl: 'https://github.com/acme/api', subdir });

    const results = await service.link(
      ann.id,
      {
        links: [
          { kind: 'codebase', projectId: 'p1', label: 'acme/api', config: repo() }, // exists (".git" folds)
          { kind: 'codebase', projectId: 'p2', label: 'acme/api', config: repo('svc/a') }, // 1-M
          { kind: 'codebase', projectId: 'p2', label: 'acme/api', config: repo('svc/b') }, // 1-M, other folder
          { kind: 'codebase', projectId: 'p2', label: 'acme/api', config: repo('svc/b/') }, // duplicate of the last
          { kind: 'markdown-git', projectId: 'p2', label: 'acme/web', config: { repoUrl: 'https://github.com/acme/web' } }, // M-1
          { kind: 'jira', projectId: 'p1', label: 'ENG', config: { baseUrl: 'https://x.atlassian.net' } }, // wrong provider
        ],
      },
      'u1',
    );
    expect(results.map((r) => r.status)).toEqual(['exists', 'created', 'created', 'exists', 'created', 'failed']);
    expect(results[0].connectorId).toBe('old');
    expect(results[3].connectorId).toBe(results[2].connectorId);
    expect(create.mock.calls.map(([input]) => input.name)).toEqual(['acme/api · Ops', 'acme/api · Ops (2)', 'acme/web · Ops']);
    expect(create.mock.calls.every(([input]) => input.connectionId === ann.id)).toBe(true);
  });
});

describe('wait', () => {
  const fast = { stepMs: 5, maxMs: 40 };

  it('answers at once without `since`, and after the timeout with no change', async () => {
    const { service } = setup();
    const now = await service.wait(WS, null, undefined, new AbortController().signal, fast);
    expect(now.changed).toBe(false);
    const started = Date.now();
    const idle = await service.wait(WS, null, now.fingerprint, new AbortController().signal, fast);
    expect(idle).toEqual({ fingerprint: now.fingerprint, changed: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it('answers as soon as a connection appears', async () => {
    const { service } = setup();
    const { fingerprint } = await service.wait(WS, null, undefined, new AbortController().signal, fast);
    const pending = service.wait(WS, null, fingerprint, new AbortController().signal, { stepMs: 5, maxMs: 5000 });
    await service.saveToken({ workspaceId: WS, provider: 'github', credential: 'ghp_ann_1' }, null);
    await expect(pending).resolves.toMatchObject({ changed: true });
  });

  it('stops polling once the client goes away', async () => {
    const { service, prisma } = setup();
    const { fingerprint } = await service.wait(WS, null, undefined, new AbortController().signal, fast);
    const gone = new AbortController();
    gone.abort();
    prisma.connection.findMany.mockClear();
    await service.wait(WS, null, fingerprint, gone.signal, { stepMs: 5, maxMs: 5000 });
    expect(prisma.connection.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('an App installation is a connection', () => {
  it('records the installation and upserts the workspace’s app connection', async () => {
    const { GithubBrowseService } = await import('../src/connectors/github/github-browse.service.js');
    const prisma = { githubInstallation: { upsert: vi.fn(async () => ({})) }, connection: { upsert: vi.fn(async () => ({ id: 'conn-1' })) } };
    const app = {
      installation: vi.fn(async () => ({ accountLogin: 'acme', accountType: 'Organization', accountAvatarUrl: 'a.png', repositorySelection: 'all', suspended: false })),
    };
    const browse = new GithubBrowseService(prisma as never, app as never, {} as never);
    await expect(browse.recordInstallation(WS, '42', 'u1')).resolves.toBe(true);
    expect(prisma.connection.upsert).toHaveBeenCalledWith({
      where: { workspaceId_provider_method_externalRef: { workspaceId: WS, provider: 'github', method: 'app', externalRef: '42' } },
      create: { workspaceId: WS, provider: 'github', method: 'app', externalRef: '42', accountId: '42', accountLabel: 'acme', accountAvatarUrl: 'a.png', createdBy: 'u1' },
      update: { accountId: '42', accountLabel: 'acme', accountAvatarUrl: 'a.png' },
    });
  });
});
