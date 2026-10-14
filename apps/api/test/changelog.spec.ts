import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConventionalCommit } from '@knowledge/contracts';

/**
 * Release notes for the repo wiki (docs/features/46): conventional commit
 * parsing, grouping, the three deterministic breaking tiers and the model's
 * separate one, the API-surface diff, tag ordering, the host history client,
 * and the adapter's changelog units — tag immutability and the backfill cap
 * above all. The network is the seam: `safeFetch` for the history client,
 * the archive and history modules for the adapter.
 */
vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));
vi.mock('../src/connectors/adapters/repo-archive.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/connectors/adapters/repo-archive.js')>();
  return { ...real, downloadRepoArchive: vi.fn(), downloadRepoArchiveAtTag: vi.fn() };
});

const { safeFetch } = await import('../src/common/safe-fetch.js');
const archive = await import('../src/connectors/adapters/repo-archive.js');
const { classifyCommits, diffApiSurface, renderReleasePage, breakingCount } = await import(
  '../src/connectors/adapters/changelog.js'
);
const history = await import('../src/connectors/adapters/repo-history.js');
const { CodebaseAdapter } = await import('../src/connectors/adapters/codebase.adapter.js');
const { TreeSitterService } = await import('../src/connectors/adapters/tree-sitter.service.js');
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

const GH = { kind: 'github' as const, origin: 'https://github.com', owner: 'acme', repo: 'demo' };
const opts = (labelled = new Map<number, string[]>()) => ({
  conventional: true,
  labelled,
  requestNumberOf: (m: string) => history.requestNumberOf(m, 'github'),
  requestUrl: (n: number) => history.requestUrl(GH, n),
  commitUrl: (sha: string) => history.commitUrl(GH, sha),
});
const commit = (sha: string, message: string) => ({ sha: sha.padEnd(40, '0'), message, date: '2026-10-01T00:00:00Z' });

describe('parseConventionalCommit', () => {
  it('reads type, scope, the bang and the footer', () => {
    expect(parseConventionalCommit('feat(api)!: drop /v1/foo')).toMatchObject({
      type: 'feat',
      scope: 'api',
      breaking: true,
      description: 'drop /v1/foo',
    });
    expect(parseConventionalCommit('fix: x\n\nBody.\n\nBREAKING CHANGE: callers must pass a locale\nRefs #3')).toMatchObject({
      type: 'fix',
      scope: null,
      breaking: true,
      breakingNote: 'callers must pass a locale',
    });
    expect(parseConventionalCommit('Feat(Web): Thing')).toMatchObject({ type: 'feat', scope: 'Web', breaking: false });
    expect(parseConventionalCommit('Update README')).toBeNull();
    expect(parseConventionalCommit('feat:missing space')).toBeNull();
  });
});

describe('classifyCommits', () => {
  it('groups by type, finds breaking by bang and by label, and links requests', () => {
    const entries = classifyCommits(
      [
        commit('a1', 'feat(api)!: drop /v1/foo (#10)'),
        commit('b2', 'feat: add bar (#11)'),
        commit('c3', 'fix: crash on empty (#12)'),
        commit('d4', 'refactor: tidy'),
        commit('e5', 'chore: bump deps (#13)'),
        commit('f6', 'Merge branch main into dev'),
      ],
      opts(new Map([[13, ['breaking']]])),
    );
    expect(entries.map((e) => [e.ref, e.group, e.sources])).toEqual([
      ['#10', 'breaking', ['conventional-commit']],
      ['#11', 'added', []],
      ['#12', 'fixed', []],
      ['d4000000'.slice(0, 7), 'changed', []],
      ['#13', 'breaking', ['label']],
    ]);
    expect(entries[0].url).toBe('https://github.com/acme/demo/pull/10');
    expect(entries[3].url).toBe(`https://github.com/acme/demo/commit/${'d4'.padEnd(40, '0')}`);
  });

  it('reads a merge commit by the title under its header, and folds a request into one entry', () => {
    const entries = classifyCommits(
      [
        commit('a1', 'wip'),
        commit('b2', 'Merge pull request #20 from acme/feat\n\nfeat(web): dark mode'),
        commit('c3', 'fix: a (#21)'),
        commit('c4', 'fix(api)!: b (#21)'),
      ],
      opts(),
    );
    expect(entries.find((e) => e.ref === '#20')).toMatchObject({ group: 'added', scope: 'web', text: 'dark mode' });
    expect(entries.filter((e) => e.ref === '#21')).toEqual([expect.objectContaining({ group: 'breaking' })]);
  });
});

describe('diffApiSurface', () => {
  const sym = (kind: string, name: string, signature: string, exported = true) => ({ kind, name, signature, exported });

  it('reports removed and changed exports as breaking-shaped, added as added, and ignores whitespace', () => {
    const changes = diffApiSurface(
      new Map([
        [
          'packages/core',
          [
            sym('function', 'gone', 'function gone(): void'),
            sym('function', 'load', 'function load(id: string): Store'),
            sym('function', 'same', 'function same( a: number ): void'),
            sym('function', 'internal', 'function internal()', false),
          ],
        ],
      ]),
      new Map([
        [
          'packages/core',
          [
            sym('function', 'load', 'function load(id: number): Store'),
            sym('function', 'same', 'function same(a: number): void'),
            sym('const', 'fresh', 'const fresh = 1'),
          ],
        ],
      ]),
    );
    expect(changes.map((c) => [c.kind, c.name])).toEqual([
      ['removed', 'gone'],
      ['changed', 'load'],
      ['added', 'fresh'],
    ]);
  });
});

describe('renderReleasePage', () => {
  it('lists confirmed breaking changes with their source, and suspicions apart', () => {
    const entries = classifyCommits(
      [commit('a1', 'feat(api)!: drop /v1/foo (#10)'), commit('b2', 'feat: rename the timeout option (#11)')],
      opts(),
    );
    const page = {
      summary: 'This release removes an endpoint.',
      entries,
      surface: [{ module: 'packages/core', kind: 'removed' as const, name: 'gone', symbolKind: 'function', before: 'function gone()', after: null }],
      suspected: [{ ref: '#11', reason: 'Renaming an option breaks configs.' }],
      surfaceNote: null,
      compareUrl: 'https://github.com/acme/demo/compare/v1.0.0...v1.1.0',
      truncated: null,
    };
    const md = renderReleasePage(page);
    const breaking = md.slice(md.indexOf('## Breaking'), md.indexOf('## Added'));
    expect(breaking).toContain('drop /v1/foo ([#10](https://github.com/acme/demo/pull/10)) · conventional commit');
    expect(breaking).toContain('Removed function `gone` from `packages/core` · API surface');
    expect(breaking).not.toContain('rename the timeout');
    expect(md.slice(md.indexOf('## Possibly breaking'))).toContain('rename the timeout option');
    expect(breakingCount(page)).toBe(2);
  });

  it('keeps commit text from restyling the page', () => {
    const entries = classifyCommits([commit('a1', 'feat: <img src=x onerror=alert(1)> [click](javascript:alert(1))')], opts());
    const md = renderReleasePage({ summary: null, entries, surface: [], suspected: [], surfaceNote: null, compareUrl: null, truncated: null });
    expect(md).not.toMatch(/<img|javascript:/);
  });
});

describe('history helpers', () => {
  it('orders tags by version, a pre-release below its release', () => {
    const sorted = history.sortTagsByVersion(
      ['v1.9.0', 'v1.10.0', 'v2.0.0-rc.1', 'v2.0.0', 'v0.1.0'].map((name) => ({ name })),
    );
    expect(sorted.map((t) => t.name)).toEqual(['v2.0.0', 'v2.0.0-rc.1', 'v1.10.0', 'v1.9.0', 'v0.1.0']);
  });

  it('finds the request a commit landed through on either host', () => {
    expect(history.requestNumberOf('feat: x (#42)', 'github')).toBe(42);
    expect(history.requestNumberOf('Merge pull request #7 from a/b\n\nfeat: y', 'github')).toBe(7);
    expect(history.requestNumberOf('feat: x\n\nSee merge request acme/demo!9', 'gitlab')).toBe(9);
    expect(history.requestNumberOf('feat: x', 'github')).toBeNull();
  });
});

const ctxFor = (config: Record<string, unknown>, userId: string | null = 'u1') => ({
  connectorId: 'c1',
  workspaceId: 'w1',
  config: { repoUrl: 'https://github.com/acme/demo', branch: 'main', ...config },
  credential: null,
  onStage: async () => undefined,
  debug: () => undefined,
  allowPrivate: false,
  userId,
  locale: 'en' as const,
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('history client (GitHub)', () => {
  beforeEach(() => mockFetch.mockReset());

  it('lists tags matching the pattern, newest first', async () => {
    mockFetch.mockResolvedValueOnce(
      json([
        { name: 'v1.0.0', commit: { sha: 'a' } },
        { name: 'nightly', commit: { sha: 'b' } },
        { name: 'v1.1.0', commit: { sha: 'c' } },
      ]),
    );
    expect(await history.listTags(ctxFor({}), 'v*')).toEqual([
      { name: 'v1.1.0', sha: 'c' },
      { name: 'v1.0.0', sha: 'a' },
    ]);
  });

  it('caps a long range at the newest commits and says so', async () => {
    mockFetch.mockResolvedValueOnce(
      json({
        total_commits: 900,
        commits: Array.from({ length: 250 }, (_, i) => ({ sha: `s${i}`, commit: { message: `fix: ${i}` } })),
        files: [{ filename: 'a.ts' }],
      }),
    );
    const range = await history.compareCommits(ctxFor({}), 'v1.0.0', 'v1.1.0', 100);
    expect(range.commits).toHaveLength(100);
    expect(range.commits[99].message).toBe('fix: 249');
    expect(range).toMatchObject({ truncated: true, total: 900, files: ['a.ts'] });
  });

  it('refuses a host it has no history API for', async () => {
    await expect(history.listTags(ctxFor({ repoUrl: 'https://git.example.com/a/b' }), 'v*')).rejects.toThrow(/GitHub or GitLab/);
  });
});

// --- the adapter's changelog units --------------------------------------------

const enc = new TextEncoder();
const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, text]) => [path, enc.encode(text)]));
const AT: Record<string, Record<string, string>> = {
  'v1.0.0': {
    'package.json': JSON.stringify({ name: 'demo' }),
    'src/index.ts': 'export function foo(): void {}\nexport function keep(a: number): void {}\n',
  },
  'v1.1.0': {
    'package.json': JSON.stringify({ name: 'demo' }),
    'src/index.ts': 'export function keep(a: number): void {}\n',
  },
};

const chat = vi.fn(async () =>
  JSON.stringify({ summary: 'A release.', suspected: [{ ref: '#11', reason: 'Renames an option.' }, { ref: '#99', reason: 'invented' }] }),
);

function adapter() {
  const values = {
    WIKI_MAX_EFFORT: 'medium',
    WIKI_DIAGRAM_MAX_NODES: 40,
    WIKI_HIGH_EFFORT_MAX_TOOL_CALLS: 5,
    CHANGELOG_MAX_RELEASES: 1,
    CHANGELOG_MAX_COMMITS_PER_RELEASE: 500,
  } as Record<string, unknown>;
  return new CodebaseAdapter(
    new TreeSitterService(),
    { resolve: async () => ({ enabled: true, config: { enabled: true, maxToolCalls: 24 }, instructions: '', missing: [] }) } as never,
    { chat } as never,
    { assertWithinBudget: async () => undefined } as never,
    { get: (key: string) => values[key] } as never,
  );
}

function serveRepo(extra: Record<string, string> = {}) {
  vi.mocked(archive.downloadRepoArchive).mockResolvedValue({
    files: files({ ...AT['v1.1.0'], 'src/new.ts': 'export const later = 1;\n', ...extra }),
    skipped: { oversize: 0, binary: 0 },
    branch: 'main',
    headSha: 'f'.repeat(40),
  });
  vi.mocked(archive.downloadRepoArchiveAtTag).mockImplementation(async (_ctx, tag) => ({
    files: files(AT[tag]),
    skipped: { oversize: 0, binary: 0 },
    branch: tag,
    headSha: null,
  }));
}

function serveHistory() {
  mockFetch.mockImplementation(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/tags?')) return json([{ name: 'v1.0.0', commit: { sha: 'a'.repeat(40) } }, { name: 'v1.1.0', commit: { sha: 'b'.repeat(40) } }]);
    if (u.includes('/search/issues')) return json({ items: [] });
    if (u.includes('/compare/v1.0.0...v1.1.0')) {
      return json({
        total_commits: 2,
        commits: [
          { sha: '1'.repeat(40), commit: { message: 'feat(api)!: drop /v1/foo (#10)', committer: { date: '2026-10-01T00:00:00Z' } } },
          { sha: '2'.repeat(40), commit: { message: 'feat: rename the timeout option (#11)', committer: { date: '2026-10-02T00:00:00Z' } } },
        ],
        files: [{ filename: 'src/index.ts' }],
      });
    }
    if (u.includes('/compare/v1.1.0...')) {
      return json({ total_commits: 1, commits: [{ sha: '3'.repeat(40), commit: { message: 'feat: later (#12)' } }], files: [{ filename: 'src/new.ts' }] });
    }
    return new Response('not found', { status: 404 });
  });
}

async function units(a: InstanceType<typeof CodebaseAdapter>, c: ReturnType<typeof ctxFor>) {
  const out: Array<{ externalId: string; version?: string; parentExternalId?: string }> = [];
  const walk = async (parent: { externalId: string; title: string } | null) => {
    for await (const ref of a.children(c, parent)) {
      out.push(ref);
      if (ref.hasChildren) await walk(ref);
    }
  };
  await walk(null);
  return out;
}

describe('CodebaseAdapter release notes', () => {
  beforeEach(() => {
    chat.mockClear();
    mockFetch.mockReset();
    serveRepo();
    serveHistory();
  });

  it('hangs Releases, Unreleased and the newest tags under the overview, capped', async () => {
    const refs = await units(adapter(), ctxFor({ changelog: 'on' }));
    const changelog = refs.filter((r) => r.externalId.startsWith('changelog'));
    expect(changelog.map((r) => [r.externalId, r.parentExternalId])).toEqual([
      ['changelog', 'overview'],
      ['changelog:unreleased', 'changelog'],
      // CHANGELOG_MAX_RELEASES = 1: only the newest tag is generated.
      ['changelog:tag:v1.1.0', 'changelog'],
    ]);
  });

  it("never re-derives a published tag's page when the steering or the effort changes", async () => {
    const before = await units(adapter(), ctxFor({ changelog: 'on' }));
    serveRepo({ '.knowledge/wiki.yml': 'focus: "something else"\neffort: low' });
    const after = await units(adapter(), ctxFor({ changelog: 'on' }));
    const v = (refs: typeof before, id: string) => refs.find((r) => r.externalId === id)?.version;
    expect(v(after, 'changelog:tag:v1.1.0')).toBe(v(before, 'changelog:tag:v1.1.0'));
    expect(v(after, 'changelog:unreleased')).not.toBe(v(before, 'changelog:unreleased'));
  });

  it('confirms breaking changes from a conventional commit and the exported API, and keeps the model apart', async () => {
    const page = await adapter().fetch(ctxFor({ changelog: 'on' }), { externalId: 'changelog:tag:v1.1.0', title: 'demo v1.1.0' });
    const breaking = page.markdown.slice(page.markdown.indexOf('## Breaking'), page.markdown.indexOf('## Added'));
    expect(breaking).toContain('drop /v1/foo');
    expect(breaking).toContain('conventional commit');
    expect(breaking).toContain('Removed function `foo`');
    expect(breaking).toContain('API surface');
    const possibly = page.markdown.slice(page.markdown.indexOf('## Possibly breaking'));
    expect(possibly).toContain('rename the timeout option');
    // A suspicion citing a label the model was never handed is dropped.
    expect(possibly).not.toContain('invented');
    expect(page.frontmatter).toMatchObject({ unit: 'changelog:tag:v1.1.0', tag: 'v1.1.0', breakingCount: 2, suspectedCount: 1 });
    expect((chat.mock.calls[0] as unknown as [{ operation: string }])[0].operation).toBe('changelog');
  });

  it('makes no model call at effort low or without an owner', async () => {
    await adapter().fetch(ctxFor({ changelog: 'on', wikiEffort: 'low' }), { externalId: 'changelog:unreleased', title: 'x' });
    const ownerless = await adapter().fetch(ctxFor({ changelog: 'on' }, null), { externalId: 'changelog:unreleased', title: 'x' });
    expect(chat).not.toHaveBeenCalled();
    expect(ownerless.warnings.join('\n')).toContain('no owner to bill');
    expect(ownerless.markdown).toContain('later');
  });

  it('lists every matching tag on the hub, marking those past the cap', async () => {
    const hub = await adapter().fetch(ctxFor({ changelog: 'on' }), { externalId: 'changelog', title: 'demo — Releases' });
    expect(hub.markdown).toContain('v1.1.0');
    expect(hub.markdown).toMatch(/v1\.0\.0 .*not generated/);
  });
});
