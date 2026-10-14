import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The repo wiki's read side and its regenerate (docs/features/46): the route
 * guards, what the Wiki tab is told (sections, derived staleness, open merge
 * requests, asked vs applied effort, a rejected steering file), how a
 * regeneration is scoped, and how the Releases tab is ordered. The host is
 * reached through `safeFetch`, which is mocked; Prisma is a fake.
 */
vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));

const { safeFetch } = await import('../src/common/safe-fetch.js');
const { RepoWikiService } = await import('../src/connectors/repo-wiki.service.js');
const { ConnectorsController } = await import('../src/connectors/connectors.controller.js');
const { ACCESS_META } = await import('../src/auth/access.decorator.js');
const mockFetch = vi.mocked(safeFetch);

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

const text = (body: string, status = 200) => new Response(body, { status });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('guards', () => {
  it('reads are viewer and regenerate is editor, all checked against the connector', () => {
    const proto = ConnectorsController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(ACCESS_META, proto.wiki)).toEqual({ role: 'viewer', source: 'connector', operator: false });
    expect(Reflect.getMetadata(ACCESS_META, proto.releases)).toEqual({ role: 'viewer', source: 'connector', operator: false });
    expect(Reflect.getMetadata(ACCESS_META, proto.regenerateWiki)).toEqual({ role: 'editor', source: 'connector', operator: false });
  });
});

function harness(config: Record<string, unknown>, kind = 'codebase') {
  const row = { id: 'c1', workspaceId: 'w1', kind, enabled: true, config: { repoUrl: 'https://github.com/acme/demo', branch: 'main', ...config } };
  const links = [
    { id: 'l0', documentId: 'd-overview', externalId: 'overview', externalVersion: 'v-ov', externalTitle: 'demo — overview', lastPulledAt: new Date('2026-10-01') },
    { id: 'l1', documentId: 'd-arch', externalId: 'wiki:architecture', externalVersion: 'v-arch', externalTitle: 'demo — Architecture', lastPulledAt: new Date('2026-10-01') },
    { id: 'l2', documentId: 'd-core', externalId: 'module:packages/core', externalVersion: 'v-core', externalTitle: 'core', lastPulledAt: new Date('2026-10-01') },
    { id: 'l3', documentId: 'd-unrel', externalId: 'changelog:unreleased', externalVersion: 'u', externalTitle: 'Unreleased', lastPulledAt: null },
    { id: 'l4', documentId: 'd-v1', externalId: 'changelog:tag:v1.0.0', externalVersion: 't1', externalTitle: 'v1.0.0', lastPulledAt: null },
    { id: 'l5', documentId: 'd-v11', externalId: 'changelog:tag:v1.1.0', externalVersion: 't2', externalTitle: 'v1.1.0', lastPulledAt: null },
  ];
  const prisma = {
    connectorLink: {
      findMany: vi.fn(async (args: { where: { externalId?: { startsWith: string } } }) =>
        args.where.externalId ? links.filter((l) => l.externalId.startsWith(args.where.externalId!.startsWith)) : links,
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    connectorRun: { findFirst: vi.fn(async () => ({ id: 'run-last' })) },
    connectorRunItem: {
      findMany: vi.fn(async () => [
        { externalId: 'module:packages/core', externalVersion: 'v-core-NEW' },
        { externalId: 'wiki:architecture', externalVersion: 'v-arch' },
      ]),
    },
    connectorConflict: { findMany: vi.fn(async () => [{ documentId: 'd-arch', mergeRequestId: 'mr-1' }]) },
    mergeRequest: { findMany: vi.fn(async () => [{ id: 'mr-1' }]) },
  };
  const connectors = {
    require: vi.fn(async () => row),
    contextFor: vi.fn(async () => ({
      connectorId: 'c1',
      workspaceId: 'w1',
      config: row.config,
      credential: null,
      onStage: async () => undefined,
      debug: () => undefined,
      allowPrivate: false,
      userId: 'u1',
      locale: 'en',
    })),
    createRun: vi.fn(async (_row: unknown, _dir: string, _trigger: string, opts: unknown) => ({ id: 'run-new', opts })),
  };
  const frontmatter: Record<string, Record<string, unknown>> = {
    'd-unrel': { breakingCount: 0, suspectedCount: 1 },
    'd-v1': { date: '2026-09-01T00:00:00Z', breakingCount: 0, suspectedCount: 0 },
    'd-v11': { date: '2026-10-01T00:00:00Z', breakingCount: 2, suspectedCount: 1 },
  };
  const documents = { getContent: vi.fn(async (id: string) => ({ frontmatter: frontmatter[id] ?? null })) };
  const values = { WIKI_MAX_EFFORT: 'medium', WIKI_DIAGRAM_MAX_NODES: 40, CHANGELOG_MAX_RELEASES: 2 } as Record<string, unknown>;
  const service = new RepoWikiService(prisma as never, connectors as never, documents as never, { get: (k: string) => values[k] } as never);
  return { service, prisma, connectors };
}

describe('RepoWikiService.info', () => {
  beforeEach(() => mockFetch.mockReset());

  it('lists the sections with derived staleness and open merge requests, and asked beside applied effort', async () => {
    mockFetch.mockResolvedValueOnce(text('effort: high\nsections: [overview, architecture, modules]'));
    const { service } = harness({ wiki: 'on', changelog: 'on' });
    const info = await service.info('c1');
    expect(info.effort).toEqual({ asked: 'high', applied: 'medium', clamped: true });
    expect(info.source).toBe('repo-file');
    expect(info.sections.map((s) => [s.key, s.section])).toEqual([
      ['overview', 'overview'],
      ['wiki:architecture', 'architecture'],
      ['changelog', 'changelog'],
      ['module:packages/core', 'modules'],
    ]);
    const byKey = Object.fromEntries(info.sections.map((s) => [s.key, s]));
    expect(byKey['module:packages/core'].stale).toBe(true);
    expect(byKey['wiki:architecture']).toMatchObject({ stale: false, openMergeRequestId: 'mr-1', documentId: 'd-arch' });
    // The hub has no link yet: listed, not created.
    expect(byKey.changelog.documentId).toBeNull();
  });

  it('reports a rejected steering file, and falls back to defaults', async () => {
    mockFetch.mockResolvedValueOnce(text('effort: extreme'));
    const info = await harness({ wiki: 'on' }).service.info('c1');
    expect(info.source).toBe('default');
    expect(info.configErrors[0]).toMatch(/^effort:/);
  });

  it('treats a 404 as no file, and refuses a connector that is not a codebase', async () => {
    mockFetch.mockResolvedValueOnce(text('Not Found', 404));
    expect((await harness({ wiki: 'on' }).service.info('c1')).source).toBe('default');
    await expect(harness({}, 'jira').service.info('c1')).rejects.toThrow(/Only a codebase connector has a repo wiki/);
  });
});

describe('RepoWikiService.regenerate', () => {
  it('refuses when neither the wiki nor release notes are on', async () => {
    await expect(harness({}).service.regenerate('c1', {})).rejects.toThrow(/Turn on Repo wiki or Release notes/);
  });

  it('scopes the run to existing pages, and forgets their versions when forced', async () => {
    const h = harness({ wiki: 'on' });
    await h.service.regenerate('c1', { sections: ['architecture', 'modules'], force: true, actorId: 'u1' });
    expect(h.prisma.connectorLink.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['l1', 'l2'] } },
      data: { externalVersion: null },
    });
    expect(h.connectors.createRun).toHaveBeenCalledWith(expect.anything(), 'pull', 'manual', {
      externalIds: ['wiki:architecture', 'module:packages/core'],
      actorId: 'u1',
    });
  });

  it('runs unscoped when a targeted page has never been created, so the walk can file it', async () => {
    const h = harness({ wiki: 'on' });
    await h.service.regenerate('c1', { sections: ['data-flow'] });
    expect(h.prisma.connectorLink.updateMany).not.toHaveBeenCalled();
    expect(h.connectors.createRun).toHaveBeenCalledWith(expect.anything(), 'pull', 'manual', { externalIds: undefined, actorId: undefined });
  });
});

describe('RepoWikiService.releases', () => {
  beforeEach(() => mockFetch.mockReset());

  it('puts Unreleased first, orders tags by version, and lists tags past the cap as not generated', async () => {
    mockFetch.mockResolvedValueOnce(
      json([
        { name: 'v1.1.0', commit: { sha: 'b' } },
        { name: 'v1.0.0', commit: { sha: 'a' } },
        { name: 'v0.9.0', commit: { sha: 'z' } },
      ]),
    );
    const { releases, error } = await harness({ changelog: 'on' }).service.releases('c1');
    expect(error).toBeNull();
    expect(releases.map((r) => [r.tag, r.generated, r.breakingCount])).toEqual([
      [null, true, 0],
      ['v1.1.0', true, 2],
      ['v1.0.0', true, 0],
      ['v0.9.0', false, 0],
    ]);
    expect(releases[1]).toMatchObject({ documentId: 'd-v11', suspectedCount: 1, date: '2026-10-01T00:00:00Z' });
  });
});
