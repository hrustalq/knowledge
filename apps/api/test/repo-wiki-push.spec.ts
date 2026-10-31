import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Push-triggered regeneration and merge-request delivery for the repo wiki
 * (docs/features/46): which deliveries count, how a burst of pushes becomes one
 * run, which updates go to a merge request instead of the page, and how the
 * sweeper titles, attributes and supersedes those merge requests. Prisma,
 * storage and the documents service are fakes; the services are the real
 * classes with their collaborators swapped in.
 */
const { readRepoPushDelivery } = await import('../src/connectors/webhook-payload.js');
const { ConnectorsService } = await import('../src/connectors/connectors.service.js');
const { ConnectorStagingService } = await import('../src/connectors/connector-staging.service.js');
const { ConnectorConflictSweeper } = await import('../src/connectors/connector-conflict.sweeper.js');
const { sha256 } = await import('../src/connectors/connector-markdown.js');

// Merge request titles are catalogued: load the real catalogs.
{
  const { join } = await import('node:path');
  const { Test } = await import('@nestjs/testing');
  const { I18nJsonLoader, I18nModule } = await import('nestjs-i18n');
  const { I18nRegistry } = await import('../src/i18n/t.js');
  const moduleRef = await Test.createTestingModule({
    imports: [
      I18nModule.forRoot({
        fallbackLanguage: 'en',
        loader: I18nJsonLoader,
        loaderOptions: { path: join(import.meta.dirname, '../src/i18n'), watch: false },
      }),
    ],
    providers: [I18nRegistry],
  }).compile();
  await moduleRef.init();
}

const WIKI_ON = { repoUrl: 'https://github.com/acme/demo', wiki: 'on', wikiAutoRegenerate: 'on-push' };

function connector(config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    workspaceId: 'w1',
    kind: 'codebase',
    enabled: true,
    syncMode: 'auto',
    locale: 'en',
    name: 'demo',
    createdBy: '22222222-2222-4222-8222-222222222222',
    config,
    ...extra,
  } as never;
}

describe('readRepoPushDelivery', () => {
  it('reads a GitHub push to a branch, and ignores tags and deletions', () => {
    const push = { ref: 'refs/heads/main', after: 'abc', repository: { default_branch: 'main' } };
    expect(readRepoPushDelivery({ 'x-github-event': 'push' }, push)).toEqual({ branch: 'main', defaultBranch: 'main' });
    expect(readRepoPushDelivery({ 'x-github-event': 'push' }, { ...push, ref: 'refs/tags/v1' })).toBeNull();
    expect(readRepoPushDelivery({ 'x-github-event': 'push' }, { ...push, deleted: true })).toBeNull();
    expect(readRepoPushDelivery({ 'x-github-event': 'push' }, { ...push, after: '0000000000' })).toBeNull();
  });

  it('reads a published release on either host as branchless, and nothing else', () => {
    expect(readRepoPushDelivery({ 'x-github-event': 'release' }, { action: 'published' })).toEqual({ branch: null, defaultBranch: null });
    expect(readRepoPushDelivery({ 'x-github-event': 'release' }, { action: 'created' })).toBeNull();
    expect(readRepoPushDelivery({ 'x-gitlab-event': 'Release Hook' }, { action: 'create' })).toEqual({ branch: null, defaultBranch: null });
    expect(
      readRepoPushDelivery({ 'x-gitlab-event': 'Push Hook' }, { ref: 'refs/heads/dev', project: { default_branch: 'main' } }),
    ).toEqual({ branch: 'dev', defaultBranch: 'main' });
    expect(readRepoPushDelivery({ 'x-github-event': 'issues' }, { action: 'opened' })).toBeNull();
  });
});

describe('ConnectorsService.queueRepoPush', () => {
  const runs: Array<Record<string, unknown>> = [];
  const prisma = {
    connectorRun: {
      findFirst: vi.fn(async () => runs.find((r) => r.status === 'queued' && r.startedAt === null) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const run = { id: `run-${runs.length + 1}`, startedAt: null, scope: null, ...data };
        runs.push(run);
        return run;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const run = runs.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
        if (run) Object.assign(run, data);
        return { count: run ? 1 : 0 };
      }),
    },
  };
  const service = Object.assign(Object.create(ConnectorsService.prototype), { prisma }) as InstanceType<
    typeof ConnectorsService
  >;

  beforeEach(() => {
    runs.length = 0;
    vi.clearAllMocks();
  });

  it('queues one unscoped run for a push to the branch it reads, and folds the next pushes into it', async () => {
    const row = connector({ ...WIKI_ON, branch: 'main' });
    const first = await service.queueRepoPush(row, { branch: 'main' });
    expect(first).toMatchObject({ trigger: 'webhook', status: 'queued', direction: 'pull', mode: 'auto' });
    expect(first).not.toHaveProperty('scope', expect.anything());
    expect(await service.queueRepoPush(row, { branch: 'main' })).toBeNull();
    expect(await service.queueRepoPush(row, { branch: 'main' })).toBeNull();
    expect(runs).toHaveLength(1);
  });

  it('ignores another branch, and matches an empty Branch against the repository default', async () => {
    expect(await service.queueRepoPush(connector({ ...WIKI_ON, branch: 'main' }), { branch: 'feature/x' })).toBeNull();
    expect(await service.queueRepoPush(connector(WIKI_ON), { branch: 'dev', defaultBranch: 'main' })).toBeNull();
    // No configured branch and no default named: refuse rather than guess.
    expect(await service.queueRepoPush(connector(WIKI_ON), { branch: 'main' })).toBeNull();
    expect(await service.queueRepoPush(connector(WIKI_ON), { branch: 'main', defaultBranch: 'main' })).not.toBeNull();
  });

  it('always runs for a release, whatever the branch', async () => {
    expect(await service.queueRepoPush(connector({ ...WIKI_ON, branch: 'main' }), { branch: null })).not.toBeNull();
  });

  it('runs for a release when release notes are on, even without push regeneration', async () => {
    const notes = connector({ repoUrl: 'https://github.com/acme/demo', changelog: 'on' });
    expect(await service.queueRepoPush(notes, { branch: 'main', defaultBranch: 'main' })).toBeNull();
    expect(await service.queueRepoPush(notes, { branch: null })).not.toBeNull();
  });

  it('does nothing unless the connector asked for it', async () => {
    expect(await service.queueRepoPush(connector({ ...WIKI_ON, wikiAutoRegenerate: 'off' }), { branch: null })).toBeNull();
    expect(await service.queueRepoPush(connector({ ...WIKI_ON, wiki: 'off' }), { branch: null })).toBeNull();
    expect(await service.queueRepoPush(connector(WIKI_ON, { enabled: false }), { branch: null })).toBeNull();
    expect(await service.queueRepoPush(connector(WIKI_ON, { kind: 'markdown-git' }), { branch: null })).toBeNull();
    expect(runs).toHaveLength(0);
  });

  it('widens a waiting scoped run to the whole repository', async () => {
    runs.push({ id: 'scoped', status: 'queued', startedAt: null, scope: ['module:a'] });
    expect(await service.queueRepoPush(connector({ ...WIKI_ON, branch: 'main' }), { branch: 'main' })).toBeNull();
    expect(runs[0].scope).not.toEqual(['module:a']);
  });

  it('gives a push its own run when the worker claimed the waiting one in between (#658)', async () => {
    runs.push({ id: 'claimed', status: 'running', startedAt: new Date(), scope: null });
    prisma.connectorRun.findFirst.mockResolvedValueOnce({ id: 'claimed', status: 'queued', startedAt: null, scope: null });
    expect(await service.queueRepoPush(connector({ ...WIKI_ON, branch: 'main' }), { branch: 'main' })).not.toBeNull();
    expect(runs).toHaveLength(2);
  });
});

describe('ConnectorStagingService.apply, delivered by merge request', () => {
  const OLD = '---\nunit: module:a\n---\nold page\n';
  const NEW = '---\nunit: module:a\nheadSha: abc\n---\nnew page\n';

  function harness(config: Record<string, unknown>) {
    const objects = new Map<string, string>([
      ['staged/1', NEW],
      ['rev/head', OLD],
    ]);
    const conflicts: Array<Record<string, unknown>> = [];
    const prisma = {
      withTransaction: async (fn: () => Promise<unknown>) => fn(),
      onCommit: (fn: () => Promise<unknown>) => void fn(),
      connectorLink: {
        findUnique: vi.fn(async () => ({ id: 'l1', documentId: 'd1', contentHash: sha256(OLD), externalUrl: null })),
        update: vi.fn(async () => undefined),
      },
      document: {
        findUnique: vi.fn(async (args: { select?: unknown }) => (args.select ? { defaultBranch: 'main' } : { id: 'd1' })),
      },
      documentBranch: { findUnique: vi.fn(async () => ({ headRevisionId: 'head' })) },
      documentRevision: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === 'head' ? { s3Key: 'rev/head', status: 'indexed' } : { s3Key: `rev/${where.id}`, status: 'finalized' },
        ),
      },
      connectorConflict: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => conflicts.push(data)),
        findFirst: vi.fn(async () => null),
      },
      connectorRunItem: { update: vi.fn(async () => undefined) },
    };
    const storage = {
      getObjectText: vi.fn(async (key: string) => objects.get(key) ?? ''),
      putObjectText: vi.fn(async (key: string, text: string) => objects.set(key, text)),
    };
    const documents = {
      createBranch: vi.fn(async () => undefined),
      createRevision: vi.fn(async () => ({ revisionId: 'r2' })),
      finalizeRevision: vi.fn(async () => undefined),
    };
    // Access mirroring is off on these connectors (#76): the mirror is a no-op.
    const acl = {
      capture: vi.fn(async () => null),
      preview: vi.fn(async () => []),
      applyToPage: vi.fn(async () => ({ changed: false, warnings: [] })),
    };
    const staging = new ConnectorStagingService(prisma as never, documents as never, storage as never, acl as never, { pinMarkdown: async (_ws: string, md: string) => md } as never);
    const row = connector(config, { conflict: 'manual' });
    return { staging, row, prisma, documents, conflicts, objects };
  }

  const run = { id: 'abcdef12-0000-4000-8000-000000000000', mode: 'auto' } as never;
  const item = (externalId: string) =>
    ({ id: 'i1', status: 'staged', stagedKey: 'staged/1', linkId: 'l1', action: 'update', externalId, title: 'A' }) as never;

  it('puts a regenerated page on a wiki branch with reason regenerated, leaving the page alone', async () => {
    const h = harness({ ...WIKI_ON, wikiDelivery: 'merge-request' });
    await h.staging.apply(h.row, run, item('module:a'));
    expect(h.documents.createBranch).toHaveBeenCalledWith('d1', { name: expect.stringMatching(/^wiki\/abcdef12-/) });
    expect(h.documents.createRevision).toHaveBeenCalledWith('d1', expect.objectContaining({ branch: expect.stringMatching(/^wiki\//) }));
    expect(h.conflicts).toEqual([expect.objectContaining({ reason: 'regenerated', documentId: 'd1' })]);
  });

  it('writes directly when delivery is direct, or the unit is not a wiki page', async () => {
    const direct = harness({ ...WIKI_ON, wikiDelivery: 'direct' });
    await direct.staging.apply(direct.row, run, item('module:a'));
    expect(direct.documents.createBranch).not.toHaveBeenCalled();
    expect(direct.documents.createRevision).toHaveBeenCalledWith('d1', expect.objectContaining({ branch: undefined }));

    const released = harness({ ...WIKI_ON, wikiDelivery: 'merge-request' });
    await released.staging.apply(released.row, run, item('changelog:v1.0.0'));
    expect(released.documents.createBranch).not.toHaveBeenCalled();
  });

  it('leaves review and step runs to the person reviewing them', async () => {
    const h = harness({ ...WIKI_ON, wikiDelivery: 'merge-request' });
    await h.staging.apply(h.row, { ...(run as object), mode: 'review' } as never, item('module:a'));
    expect(h.documents.createBranch).not.toHaveBeenCalled();
  });

  it('reads an untouched page carrying frontmatter as unchanged, and a merged regeneration as ours', async () => {
    const h = harness(WIKI_ON);
    const decide = (h.staging as unknown as { decideAction: (row: unknown, link: unknown) => Promise<string> }).decideAction.bind(
      h.staging,
    );
    // The head holds exactly what was last written, frontmatter and all.
    expect(await decide(h.row, { id: 'l1', documentId: 'd1', contentHash: sha256(OLD) })).toBe('update');

    // The head moved to a merged regeneration: still the connector's own page.
    h.objects.set('rev/head', NEW);
    h.objects.set('rev/r9', NEW);
    h.prisma.connectorConflict.findFirst.mockResolvedValueOnce({ revisionId: 'r9' } as never);
    expect(await decide(h.row, { id: 'l1', documentId: 'd1', contentHash: sha256(OLD) })).toBe('update');

    // A person edited it: that is a conflict.
    h.objects.set('rev/head', `${OLD}edited\n`);
    expect(await decide(h.row, { id: 'l1', documentId: 'd1', contentHash: sha256(OLD) })).toBe('conflict');
  });
});

describe('ConnectorConflictSweeper, regenerated pages', () => {
  function harness(rows: Array<Record<string, unknown>>) {
    const owner = '22222222-2222-4222-8222-222222222222';
    const conn = { id: 'c1', name: 'demo', locale: 'en', createdBy: owner };
    const prisma = {
      withTransaction: async (fn: () => Promise<unknown>) => fn(),
      onCommit: (fn: () => Promise<unknown>) => void fn(),
      connectorConflict: {
        findMany: vi.fn(async (args: { where: { status: string } }) =>
          args.where.status === 'pending'
            ? rows.filter((r) => r.status === 'pending').map((r) => ({ ...r, connector: conn }))
            : rows.filter((r) => r.status === 'resolved' && r.id !== (args.where as { id?: { not: string } }).id?.not),
        ),
        findFirst: vi.fn(async (args: { where: { createdAt: { gt: Date }; documentId: string } }) =>
          rows.find(
            (r) =>
              r.status === 'pending' &&
              r.documentId === args.where.documentId &&
              (r.createdAt as Date) > args.where.createdAt.gt,
          ) ?? null,
        ),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
          Object.assign(rows.find((r) => r.id === where.id)!, data),
        ),
      },
      documentRevision: { findUnique: vi.fn(async () => ({ s3Key: 'rev/x' })) },
    };
    const mergeRequests = {
      create: vi.fn(async () => ({ mergeRequest: { mergeRequestId: `mr-${Math.random()}` } })),
      get: vi.fn(async () => ({ mergeRequest: { status: 'open' } })),
      close: vi.fn(async () => undefined),
    };
    const storage = { getObjectText: vi.fn(async () => '---\nunit: module:a\nheadSha: 0123456789abcdef\n---\nbody') };
    const sweeper = new ConnectorConflictSweeper(prisma as never, mergeRequests as never, storage as never);
    return { sweeper, mergeRequests, rows, owner };
  }

  const base = { documentId: 'd1', branch: 'wiki/x', revisionId: 'r1', externalUrl: 'https://github.com/acme/demo', title: 'A' };

  it('titles it as a regeneration, names the commit, and attributes it to the owner', async () => {
    const h = harness([{ id: 'k1', status: 'pending', reason: 'regenerated', createdAt: new Date(1), ...base }]);
    await h.sweeper.sweep();
    const [documentId, dto, author] = h.mergeRequests.create.mock.calls[0] as unknown as [
      string,
      { title: string; description: string },
      string,
    ];
    expect(documentId).toBe('d1');
    expect(dto.title).toBe('demo: regenerated "A"');
    expect(dto.description).toContain('0123456789ab');
    expect(author).toBe(h.owner);
  });

  it('opens only the newest of a burst, and closes the older open one it replaces', async () => {
    const h = harness([
      { id: 'old', status: 'resolved', reason: 'regenerated', mergeRequestId: 'mr-old', createdAt: new Date(1), ...base },
      { id: 'k1', status: 'pending', reason: 'regenerated', createdAt: new Date(2), ...base },
      { id: 'k2', status: 'pending', reason: 'regenerated', createdAt: new Date(3), ...base },
    ]);
    await h.sweeper.sweep();
    expect(h.rows.find((r) => r.id === 'k1')!.status).toBe('superseded');
    expect(h.mergeRequests.create).toHaveBeenCalledTimes(1);
    expect(h.mergeRequests.close).toHaveBeenCalledWith('mr-old', h.owner);
  });

  it('keeps the conflict wording, and the stub author, for a plain conflict', async () => {
    const h = harness([{ id: 'k1', status: 'pending', reason: 'conflict', createdAt: new Date(1), ...base }]);
    await h.sweeper.sweep();
    const [, dto, author] = h.mergeRequests.create.mock.calls[0] as unknown as [string, { title: string }, string | undefined];
    expect(dto.title).toBe('demo: incoming change to "A"');
    expect(author).toBeUndefined();
    expect(h.mergeRequests.close).not.toHaveBeenCalled();
  });
});
