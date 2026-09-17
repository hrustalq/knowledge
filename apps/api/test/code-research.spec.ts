import { describe, expect, it, vi } from 'vitest';

/**
 * The code research tools (docs/features/31).
 *
 * The pure half — paths, globs, patterns, tree listing, line windows — is
 * exercised directly. The snapshot cache is exercised with the archive download
 * mocked at its seam, because everything the cache promises (one download per
 * TTL, a reload when the connector changes, eviction over the byte cap, a
 * failed download not served for the rest of the TTL) is defined by when that
 * function is called. Nothing here touches the network or Nest.
 */
vi.mock('../src/connectors/adapters/repo-archive.js', () => ({
  downloadRepoArchive: vi.fn(),
  resolveBranch: vi.fn(async () => 'main'),
  repoSubdir: vi.fn(() => ''),
  repoHost: vi.fn(() => ({ kind: 'github', origin: 'https://github.com', owner: 'acme', repo: 'svc' })),
  blobUrl: vi.fn((_ctx: unknown, path: string, branch: string) => `https://github.com/acme/svc/blob/${branch}/${path}`),
}));

const archive = await import('../src/connectors/adapters/repo-archive.js');
const { compileSearch, globToRegExp, listTree, normalizeRepoPath, windowLines } = await import(
  '../src/connectors/code-research/code-research.service.js'
);
const { RepoSnapshotService, lineAnchor } = await import('../src/connectors/code-research/repo-snapshot.service.js');

const enc = new TextEncoder();
const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, text]) => [path, enc.encode(text)]));

describe('normalizeRepoPath', () => {
  it('strips leading ./ and /, trailing /, and reads the root as empty', () => {
    expect(normalizeRepoPath('')).toBe('');
    expect(normalizeRepoPath('/')).toBe('');
    expect(normalizeRepoPath('.')).toBe('');
    expect(normalizeRepoPath('./src/')).toBe('src');
    expect(normalizeRepoPath('/src/a//b.ts')).toBe('src/a/b.ts');
    expect(normalizeRepoPath('src\\win\\path.ts')).toBe('src/win/path.ts');
  });

  it('refuses a path that climbs', () => {
    expect(() => normalizeRepoPath('../etc/passwd')).toThrow();
    expect(() => normalizeRepoPath('src/../../x')).toThrow();
    // Climbing that stays inside is just a path.
    expect(normalizeRepoPath('src/a/../b.ts')).toBe('src/b.ts');
  });
});

describe('globToRegExp', () => {
  it('matches a bare filename pattern at any depth and * within one segment', () => {
    const go = globToRegExp('*.go');
    expect(go.test('main.go')).toBe(true);
    expect(go.test('cmd/api/main.go')).toBe(true);
    expect(go.test('main.go.txt')).toBe(false);
  });

  it('lets ** cross directories and a trailing directory glob take its subtree', () => {
    const ts = globToRegExp('src/**/*.ts');
    expect(ts.test('src/a.ts')).toBe(true);
    expect(ts.test('src/a/b/c.ts')).toBe(true);
    expect(ts.test('lib/a.ts')).toBe(false);
    expect(ts.test('src/a.tsx')).toBe(false);

    const dir = globToRegExp('apps/api/**');
    expect(dir.test('apps/api/src/main.ts')).toBe(true);
    expect(dir.test('apps/web/src/main.ts')).toBe(false);
  });

  it('escapes regex characters in the pattern', () => {
    expect(globToRegExp('a.b').test('axb')).toBe(false);
    expect(globToRegExp('a.b').test('a.b')).toBe(true);
  });
});

describe('compileSearch', () => {
  it('is a case-folded substring by default', () => {
    const m = compileSearch('Price', { regex: false, caseSensitive: false });
    expect(m('const price = 1')).toBe(true);
    expect(compileSearch('Price', { regex: false, caseSensitive: true })('const price = 1')).toBe(false);
  });

  it('compiles a regular expression and reports a bad one', () => {
    expect(compileSearch('^export (const|function)', { regex: true, caseSensitive: false })('export const x')).toBe(true);
    expect(() => compileSearch('(', { regex: true, caseSensitive: false })).toThrow(/Invalid regular expression/);
  });

  it('refuses the nested-quantifier shape that backtracks without bound', () => {
    expect(() => compileSearch('(a+)+$', { regex: true, caseSensitive: false })).toThrow(/backtrack/);
    expect(() => compileSearch('(\\w*)*x', { regex: true, caseSensitive: false })).toThrow(/backtrack/);
    // A quantified group without a quantifier inside is fine.
    expect(() => compileSearch('(ab)+', { regex: true, caseSensitive: false })).not.toThrow();
  });
});

describe('listTree', () => {
  const repo = files({
    'README.md': '# hi',
    'src/a.ts': 'a'.repeat(10),
    'src/b.ts': 'b'.repeat(20),
    'src/deep/c.ts': 'c',
    'src/deep/er/d.ts': 'd',
  });

  it('lists directories first with their recursive file counts, then files, within the depth', () => {
    const { entries, truncated } = listTree(repo, '', 1, 100);
    expect(truncated).toBe(false);
    expect(entries.map((e) => `${e.kind}:${e.path}`)).toEqual(['dir:src', 'file:README.md']);
    expect(entries[0]).toMatchObject({ files: 4, bytes: 32 });
  });

  it('descends under a path to the requested depth', () => {
    const { entries } = listTree(repo, 'src', 2, 100);
    expect(entries.map((e) => e.path)).toEqual(['src/deep', 'src/deep/er', 'src/a.ts', 'src/b.ts', 'src/deep/c.ts']);
    expect(entries.find((e) => e.path === 'src/a.ts')).toMatchObject({ language: 'typescript', bytes: 10 });
  });

  it('caps the listing and says so', () => {
    const { entries, truncated } = listTree(repo, '', 4, 2);
    expect(entries).toHaveLength(2);
    expect(truncated).toBe(true);
  });
});

describe('windowLines', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);

  it('numbers the lines and honours the requested range', () => {
    const w = windowLines(lines, 10, 12, 400, 24_000);
    expect(w).toMatchObject({ start: 10, end: 12, truncated: false });
    expect(w.lines).toEqual(['10│ line 10', '11│ line 11', '12│ line 12']);
  });

  it('stops at the line cap and at the character cap, and reports it', () => {
    expect(windowLines(lines, 1, 50, 5, 24_000)).toMatchObject({ start: 1, end: 5, truncated: true });
    const byChars = windowLines(lines, 1, 50, 400, 30);
    expect(byChars.end).toBeLessThan(50);
    expect(byChars.truncated).toBe(true);
    expect(byChars.lines.length).toBeGreaterThan(0);
  });
});

describe('lineAnchor', () => {
  const github = { kind: 'github' as const, origin: 'https://github.com', owner: 'a', repo: 'b' };
  const gitlab = { ...github, kind: 'gitlab' as const };

  it('uses each host’s own range syntax', () => {
    expect(lineAnchor(github, [10, 20])).toBe('#L10-L20');
    expect(lineAnchor(gitlab, [10, 20])).toBe('#L10-20');
    expect(lineAnchor(github, [10])).toBe('#L10');
    expect(lineAnchor(github, [10, 10])).toBe('#L10');
    expect(lineAnchor(github)).toBe('');
  });
});

describe('RepoSnapshotService', () => {
  const download = vi.mocked(archive.downloadRepoArchive);

  function service(opts: { ttlMs?: number; maxBytes?: number; rows: Array<Record<string, unknown>> }) {
    const rows = new Map(opts.rows.map((r) => [r.id as string, r]));
    const connectors = {
      require: vi.fn(async (id: string) => {
        const row = rows.get(id);
        if (!row) throw new Error(`not found ${id}`);
        return row;
      }),
      contextFor: vi.fn(async (row: { id: string }) => ({ connectorId: row.id, config: {}, credential: 'secret' })),
    };
    const prisma = { connector: { findMany: vi.fn(async () => [...rows.values()]) } };
    const config = {
      get: (key: string) => (key === 'CODE_SNAPSHOT_TTL_MS' ? (opts.ttlMs ?? 60_000) : (opts.maxBytes ?? 1 << 30)),
    };
    // Constructed directly: what is under test is the cache, not the wiring.
    return new RepoSnapshotService(prisma as never, connectors as never, config as never);
  }

  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    workspaceId: 'w1',
    kind: 'codebase',
    name: `repo-${id}`,
    enabled: true,
    config: { repoUrl: 'https://github.com/acme/svc' },
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  });

  it('downloads once per TTL and reloads when the connector row changes', async () => {
    download.mockReset();
    download.mockResolvedValue({ files: files({ 'a.ts': 'x' }), skipped: { oversize: 0, binary: 0 }, branch: 'main' });
    const rows = [row('c1')];
    const svc = service({ rows });

    const first = await svc.open('c1', 'w1');
    const second = await svc.open('c1', 'w1');
    expect(second).toBe(first);
    expect(download).toHaveBeenCalledTimes(1);
    expect(first.blobUrl('a.ts', [3, 4])).toBe('https://github.com/acme/svc/blob/main/a.ts#L3-L4');
    // The credential lives in the context the closure holds, never on the snapshot.
    expect(JSON.stringify(first)).not.toContain('secret');

    rows[0].updatedAt = new Date('2026-02-01T00:00:00Z');
    await svc.open('c1', 'w1');
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('refuses another workspace, a wrong kind and a disabled connector on every open', async () => {
    download.mockReset();
    download.mockResolvedValue({ files: files({}), skipped: { oversize: 0, binary: 0 }, branch: 'main' });
    const svc = service({
      rows: [row('c1'), row('c2', { kind: 'notion' }), row('c3', { enabled: false })],
    });
    // Outside a request there is no locale, so `t()` returns the key itself —
    // which is also what makes the reason checkable here.
    await expect(svc.open('c1', 'w2')).rejects.toThrow(/error\.connector\.notFound/);
    await expect(svc.open('c2', 'w1')).rejects.toThrow(/error\.code\.notARepository/);
    await expect(svc.open('c3', 'w1')).rejects.toThrow(/error\.code\.connectorDisabled/);
    expect(download).not.toHaveBeenCalled();
  });

  it('does not serve a failed download for the rest of the TTL', async () => {
    download.mockReset();
    download
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValue({ files: files({ 'a.ts': 'x' }), skipped: { oversize: 0, binary: 0 }, branch: 'main' });
    const svc = service({ rows: [row('c1')] });
    await expect(svc.open('c1', 'w1')).rejects.toThrow('404');
    await expect(svc.open('c1', 'w1')).resolves.toMatchObject({ branch: 'main' });
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used snapshot once the process is over the byte cap', async () => {
    download.mockReset();
    download.mockImplementation(async (ctx: { connectorId: string }) => ({
      files: files({ 'big.txt': 'x'.repeat(600) }),
      skipped: { oversize: 0, binary: 0 },
      branch: ctx.connectorId,
    }));
    const svc = service({ rows: [row('c1'), row('c2')], maxBytes: 1_000 });
    await svc.open('c1', 'w1');
    await svc.open('c2', 'w1');
    // c1 was least recently used and the two together exceed the cap.
    await svc.open('c1', 'w1');
    expect(download).toHaveBeenCalledTimes(3);
  });

  it('lists only enabled repository connectors, with the branch left null when unset', async () => {
    const svc = service({
      rows: [row('c1'), row('c2', { config: { repoUrl: 'https://gitlab.com/a/b', branch: 'dev', subdir: '/docs/' } })],
    });
    const repos = await svc.listRepos('w1');
    expect(repos).toEqual([
      { id: 'c1', name: 'repo-c1', repoUrl: 'https://github.com/acme/svc', branch: null, subdir: '' },
      { id: 'c2', name: 'repo-c2', repoUrl: 'https://gitlab.com/a/b', branch: 'dev', subdir: 'docs' },
    ]);
  });
});
