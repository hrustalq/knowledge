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
const { CredentialsService } = await import('../src/connectors/credentials.service.js');
const { decryptSecret } = await import('../src/ai/secret-box.js');

const WS = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const ANN = '33333333-3333-4333-8333-333333333333';
const BOB = '44444444-4444-4444-8444-444444444444';
const key = randomBytes(32).toString('base64');

function setup(members: Array<{ workspaceId: string; userId: string }> = []) {
  let seq = 0;
  const connections: Array<Record<string, unknown>> = [];
  const connectors: Array<Record<string, unknown>> = [];
  const credentials: Array<Record<string, unknown>> = [];
  const test = (r: Record<string, unknown>, k: string, v: unknown): boolean =>
    k === 'OR'
      ? (v as Record<string, unknown>[]).some((w) => Object.entries(w).every(([kk, vv]) => test(r, kk, vv)))
      : v && typeof v === 'object' && 'in' in v
        ? (v as { in: unknown[] }).in.includes(r[k])
        : v && typeof v === 'object' && 'not' in v
          ? (r[k] ?? null) !== (v as { not: unknown }).not
          : (r[k] ?? null) === v;
  const pick = <T extends Record<string, unknown>>(rows: T[], where: Record<string, unknown> = {}) =>
    rows.filter((r) => Object.entries(where).every(([k, v]) => test(r, k, v)));
  const withConnectors = (c: Record<string, unknown>) => ({
    ...c,
    connectors: pick(connectors, { connectionId: c.id }),
    credentialRow: credentials.find((r) => r.id === c.credentialId) ?? null,
  });
  const prisma = {
    credential: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => pick(credentials, where)),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => credentials.find((r) => r.id === where.id) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { accountId: null, accountLabel: null, accountAvatarUrl: null, ...data, id: `cred-${++seq}`, createdAt: new Date(), updatedAt: new Date() };
        credentials.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(credentials.find((r) => r.id === where.id)!, data),
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => credentials.splice(credentials.findIndex((r) => r.id === where.id), 1)),
    },
    workspaceMember: { findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => pick(members, where)) },
    workspace: { findMany: vi.fn(async () => [{ id: WS, name: 'Acme' }, { id: WS_B, name: 'Beta' }]) },
    connection: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => pick(connections, where).map(withConnectors)),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => pick(connections, where)[0] ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const rows = pick(connections, where);
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }),
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
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const create = vi.fn(async (input: Record<string, unknown>) => {
    const row = { id: `c-${++seq}`, ...input };
    connectors.push(row);
    return row;
  });
  const config = { get: (k: string) => (k === 'SETTINGS_ENCRYPTION_KEY' ? key : false) };
  const creds = new CredentialsService(prisma as never, config as never);
  const service = new ConnectionsService(
    prisma as never,
    config as never,
    { create } as never,
    { configured: false } as never,
    { configured: false } as never,
    {} as never,
    creds,
  );
  return { service, creds, connections, connectors, credentials, create, prisma };
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
    await expect(service.rotate(ann.id, { credential: 'ghp_bob_1' }, null)).rejects.toThrow(/otherAccount/);
    await expect(service.rotate(ann.id, { credential: 'ghp_ann_9' }, null)).resolves.toMatchObject({ accountLabel: 'ann' });
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

describe('credentials (#857)', () => {
  const secretOf = (ctx: ReturnType<typeof setup>, connectionId: string) => {
    const c = ctx.connections.find((r) => r.id === connectionId)!;
    return decryptSecret(ctx.credentials.find((r) => r.id === c.credentialId)!.secret as string, Buffer.from(key, 'base64'));
  };

  it("reuses the owner's pasted token in another workspace with no re-paste, and nobody else may bind it", async () => {
    const ctx = setup([{ workspaceId: WS, userId: ANN }, { workspaceId: WS_B, userId: ANN }]);
    const inA = await ctx.service.saveToken({ workspaceId: WS, provider: 'gitlab', credential: 'glpat_ann_1' }, ANN);
    expect(inA).toMatchObject({ ownerId: ANN, ownerLeft: false, credentialId: ctx.credentials[0].id });
    const [mine] = await ctx.creds.list(ANN);
    expect(mine).toMatchObject({ provider: 'gitlab', site: 'https://gitlab.com', accountLabel: 'ann', bindable: true });
    expect(mine).not.toHaveProperty('secret');
    expect(await ctx.creds.list(BOB)).toEqual([]);

    await expect(ctx.service.saveToken({ workspaceId: WS_B, provider: 'gitlab', credentialId: mine.id }, BOB)).rejects.toThrow(/notYours/);
    const inB = await ctx.service.saveToken({ workspaceId: WS_B, provider: 'gitlab', credentialId: mine.id }, ANN);
    expect(inB).toMatchObject({ workspaceId: WS_B, site: 'https://gitlab.com', credentialId: mine.id });
    expect(ctx.credentials).toHaveLength(1);
    expect(secretOf(ctx, inB.id)).toBe('glpat_ann_1');
    expect((await ctx.creds.list(ANN))[0].usedBy.map((u) => u.workspaceName)).toEqual(['Acme', 'Beta']);
  });

  it('rotates once for every workspace, and refuses a disconnect while one uses it', async () => {
    const ctx = setup([{ workspaceId: WS, userId: ANN }, { workspaceId: WS_B, userId: ANN }]);
    const inA = await ctx.service.saveToken({ workspaceId: WS, provider: 'github', credential: 'ghp_ann_1' }, ANN);
    const inB = await ctx.service.saveToken({ workspaceId: WS_B, provider: 'github', credentialId: inA.credentialId! }, ANN);
    ctx.connectors.push({ id: 'c1', name: 'Runbooks', connectionId: inB.id, credential: 'old' });

    await ctx.service.rotateCredential(inA.credentialId!, 'ghp_ann_2', ANN);
    expect([secretOf(ctx, inA.id), secretOf(ctx, inB.id)]).toEqual(['ghp_ann_2', 'ghp_ann_2']);
    // The copies the previous release dials with follow.
    expect(ctx.connectors[0].credential).toBe(ctx.credentials[0].secret);
    expect(ctx.connections.every((c) => c.credential === ctx.credentials[0].secret)).toBe(true);
    await expect(ctx.service.rotateCredential(inA.credentialId!, 'ghp_bob_1', ANN)).rejects.toThrow(/otherAccount/);

    await expect(ctx.creds.remove(inA.credentialId!, ANN)).rejects.toMatchObject({ response: { workspaces: ['Acme', 'Beta'], connectors: ['Runbooks'] } });
    ctx.connections.length = 0;
    await expect(ctx.creds.remove(inA.credentialId!, ANN)).resolves.toBeUndefined();
    expect(ctx.credentials).toHaveLength(0);
  });

  it('flags a connection whose owner left, and another admin rebinds it to their own account', async () => {
    const ctx = setup([{ workspaceId: WS, userId: BOB }]);
    const conn = await ctx.service.saveToken({ workspaceId: WS, provider: 'github', credential: 'ghp_ann_1' }, ANN);
    expect(conn).toMatchObject({ ownerId: ANN, ownerLeft: true });
    const rebound = await ctx.service.rotate(conn.id, { credential: 'ghp_ann_7' }, BOB);
    expect(rebound).toMatchObject({ id: conn.id, ownerId: BOB, ownerLeft: false });
    // Ann's own credential was not touched: Bob's paste is Bob's.
    expect(decryptSecret(ctx.credentials.find((c) => c.userId === ANN)!.secret as string, Buffer.from(key, 'base64'))).toBe('ghp_ann_1');
  });

  it('keeps one Atlassian credential across sites, probing it on the site it is used on', async () => {
    const ctx = setup([{ workspaceId: WS, userId: ANN }]);
    const one = await ctx.service.saveToken({ workspaceId: WS, provider: 'atlassian', site: 'https://acme.atlassian.net', credential: 'tok_ann_1' }, ANN);
    expect(ctx.credentials[0].site).toBeNull();
    const two = await ctx.service.saveToken({ workspaceId: WS_B, provider: 'atlassian', site: 'https://beta.atlassian.net', credentialId: one.credentialId! }, ANN);
    expect(two).toMatchObject({ site: 'https://beta.atlassian.net', credentialId: one.credentialId });
    await expect(
      ctx.service.saveToken({ workspaceId: WS_B, provider: 'atlassian', credentialId: one.credentialId! }, ANN),
    ).rejects.toThrow(/siteRequired/);
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
    await expect(browse.recordInstallation(WS, '42', 'u1')).resolves.toBe('conn-1');
    expect(prisma.connection.upsert).toHaveBeenCalledWith({
      where: { workspaceId_provider_method_externalRef: { workspaceId: WS, provider: 'github', method: 'app', externalRef: '42' } },
      create: { workspaceId: WS, provider: 'github', method: 'app', externalRef: '42', accountId: '42', accountLabel: 'acme', accountAvatarUrl: 'a.png', createdBy: 'u1' },
      update: { accountId: '42', accountLabel: 'acme', accountAvatarUrl: 'a.png' },
      select: { id: true },
    });
  });
});

describe('a second workspace adds an installation it already has (#855)', () => {
  const raw = (id: number, login: string) => ({ id, account: { login, type: 'User', avatar_url: null }, repository_selection: 'all', suspended_at: null });

  async function setup(recorded: number[]) {
    const { GithubBrowseService } = await import('../src/connectors/github/github-browse.service.js');
    const { toAccount } = await import('../src/connectors/github/github-app.service.js');
    const prisma = {
      githubInstallation: {
        findMany: vi.fn(async () => recorded.map((installationId) => ({ installationId: BigInt(installationId) }))),
        upsert: vi.fn(async () => ({})),
      },
      connection: { upsert: vi.fn(async () => ({ id: 'conn-7' })) },
    };
    const app = {
      apiUrl: 'https://api.github.com',
      installation: vi.fn(async () => ({ accountLogin: 'me', accountType: 'User', accountAvatarUrl: null, repositorySelection: 'all', suspended: false })),
    };
    const oauth = { tokenFor: vi.fn(async () => 'user-token') };
    const browse = new GithubBrowseService(prisma as never, app as never, oauth as never);
    // What the caller's own `/user/installations` answers.
    Object.assign(browse, { userInstallations: async () => [raw(1, 'me'), raw(2, 'acme')].map(toAccount) });
    return { browse, prisma, oauth };
  }

  it('lists reachable installations the workspace has not added as available', async () => {
    const { browse } = await setup([1]);
    const res = await browse.installations(WS, 'u1');
    expect(res.installations.map((a) => a.installationId)).toEqual(['1']);
    expect(res.available.map((a) => a.installationId)).toEqual(['2']);
  });

  it('adds a reachable installation as the workspace app connection', async () => {
    const { browse, prisma } = await setup([]);
    await expect(browse.addInstallation(WS, 'u1', '2')).resolves.toEqual({ connectionId: 'conn-7' });
    expect(prisma.githubInstallation.upsert).toHaveBeenCalledTimes(1);
  });

  it('refuses an installation the caller cannot see, writing nothing', async () => {
    const { browse, prisma } = await setup([]);
    await expect(browse.addInstallation(WS, 'u1', '99')).resolves.toEqual({ error: 'notVisible' });
    expect(prisma.githubInstallation.upsert).not.toHaveBeenCalled();
    expect(prisma.connection.upsert).not.toHaveBeenCalled();
  });

  it('refuses without a GitHub sign-in', async () => {
    const { browse, oauth, prisma } = await setup([]);
    oauth.tokenFor.mockResolvedValueOnce(null as never);
    await expect(browse.addInstallation(WS, 'u1', '2')).resolves.toEqual({ error: 'notConnected' });
    expect(prisma.githubInstallation.upsert).not.toHaveBeenCalled();
  });
});
