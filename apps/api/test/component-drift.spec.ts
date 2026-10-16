import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@prisma/client';
import type { AgentFinding, AgentRunDetails, AgentRunPullRequest } from '@knowledge/contracts';

/**
 * Component pages, phase 4 (#236): the drift check through component
 * declarations.
 *
 * What a green run does not show: that a page declaring a changed file is the
 * strongest tie, that the pages documenting its usages are judged under the
 * same cap and listed past it, that an importer the pull request adds counts
 * (the head is laid over the index), and that a declared path the change
 * removes or moves becomes a frontmatter fix with no model in it.
 */

// The head of the pull request, served without a host.
const headFiles = new Map<string, string>();
vi.mock('../src/connectors/adapters/repo-history.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/connectors/adapters/repo-history.js')>()),
  readRepoFile: vi.fn(async (_ctx: unknown, path: string) => headFiles.get(path) ?? null),
}));
vi.mock('../src/connectors/adapters/pull-request.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/connectors/adapters/pull-request.js')>()),
  upsertPullRequestComment: vi.fn(async () => undefined),
}));

const {
  applyPathFixes,
  declaredChanges,
  declaredPathFixes,
  overlayImports,
} = await import('../src/components/component-match.js');
const { withComponentPaths } = await import('../src/common/frontmatter.js');
const { affectedUsagesDetails, componentPathFinding, MAX_DRIFT_PAGES, MAX_UNDOCUMENTED_SITES } = await import('../src/agents/drift.js');
const { renderDriftComment } = await import('../src/connectors/drift/drift-report.js');
const { ComponentUsagesService } = await import('../src/components/component-usages.service.js');
const { PullRequestService } = await import('../src/connectors/code-research/pull-request.service.js');
const { TreeSitterService } = await import('../src/connectors/adapters/tree-sitter.service.js');
const { AgentExecutor } = await import('../src/agents/agent.executor.js');
const { DriftPublishSweeper } = await import('../src/connectors/drift/drift-publish.sweeper.js');
const { upsertPullRequestComment } = await import('../src/connectors/adapters/pull-request.js');
const { AgentFindingsService } = await import('../src/ai/agent-findings.service.js');

const POPOVER = 'apps/web/src/components/ui/popover/ResponsivePopover.vue';
const BARREL = 'apps/web/src/components/ui/popover/index.ts';

const pr: AgentRunPullRequest = {
  number: 7,
  title: 'Popover keeps focus',
  url: 'https://github.com/acme/app/pull/7',
  headSha: 'feedface0000',
  headRef: 'feat/focus',
  baseRef: 'main',
} as AgentRunPullRequest;

describe('declared changes and path fixes', () => {
  const files = [
    { path: 'src/new/b.ts', previousPath: 'src/old/b.ts', status: 'renamed' as const },
    { path: 'src/gone.ts', previousPath: null, status: 'removed' as const },
    { path: 'lib/x/one.ts', previousPath: 'lib/a/one.ts', status: 'renamed' as const },
    { path: 'lib/x/two.ts', previousPath: 'lib/a/two.ts', status: 'renamed' as const },
  ];

  it('ties a declaration to a changed file by its path or the path it had', () => {
    expect(declaredChanges(['src/old'], files)).toEqual(['src/new/b.ts']);
    expect(declaredChanges(['src/**/*.ts'], files)).toEqual(['src/new/b.ts', 'src/gone.ts']);
    expect(declaredChanges(['docs'], files)).toEqual([]);
  });

  it('moves a declared file, drops a removed one, and leaves a glob alone', () => {
    expect(declaredPathFixes(['src/old/b.ts', 'src/gone.ts', 'src/**/*.ts'], files, null)).toEqual([
      { from: 'src/old/b.ts', to: 'src/new/b.ts' },
      { from: 'src/gone.ts', to: null },
    ]);
  });

  it('moves a directory only when every file in it moved to the same place', () => {
    const base = new Set(['lib/a/one.ts', 'lib/a/two.ts', 'lib/b/keep.ts']);
    expect(declaredPathFixes(['lib/a/', 'lib/b'], files, base)).toEqual([{ from: 'lib/a/', to: 'lib/x' }]);
    // A file left behind means the directory still exists.
    expect(declaredPathFixes(['lib/a'], files, new Set([...base, 'lib/a/three.ts']))).toEqual([]);
    // Without the default branch's files a directory cannot be told from a missing file.
    expect(declaredPathFixes(['lib/a'], files, null)).toEqual([]);
  });

  it('applies fixes in place and drops what is gone', () => {
    expect(applyPathFixes(['a.ts', 'b.ts', 'c.ts'], [{ from: 'a.ts', to: 'z.ts' }, { from: 'b.ts', to: null }])).toEqual(['z.ts', 'c.ts']);
  });

  it('edits only the moved entries of a page, as written, and refuses an edit that leaves nothing', () => {
    const data = { title: 'Popover', component: { repository: 'acme/app', paths: ['./src/old/b.ts', 'src/keep.ts'], symbols: ['B'] } };
    expect(withComponentPaths(data, [{ from: 'src/old/b.ts', to: 'src/new/b.ts' }])).toEqual({
      title: 'Popover',
      component: { repository: 'acme/app', paths: ['src/new/b.ts', 'src/keep.ts'], symbols: ['B'] },
    });
    expect(withComponentPaths(data, [{ from: 'src/elsewhere.ts', to: null }])).toBeNull();
    expect(withComponentPaths({ component: { paths: 'src/gone.ts' } }, [{ from: 'src/gone.ts', to: null }])).toBeNull();
  });

  it('writes a path finding no model touched: the edit when something remains, none when the component is gone', () => {
    const moved = componentPathFinding({ id: 'd1', title: 'Popover' }, ['src/old/b.ts', 'src/keep.ts'], [{ from: 'src/old/b.ts', to: 'src/new/b.ts' }], pr);
    expect(moved).toMatchObject({ kind: 'stale', severity: 'warning', documentIds: ['d1'], componentPaths: [{ from: 'src/old/b.ts', to: 'src/new/b.ts' }] });
    // Text is rendered through t(), which answers with the key in a spec.
    expect(moved.detail).toBe('agent.drift.paths.moved');
    expect(moved.sources?.[0].url).toBe(pr.url);
    const gone = componentPathFinding({ id: 'd1', title: 'Popover' }, ['src/gone.ts'], [{ from: 'src/gone.ts', to: null }], pr);
    expect(gone.detail).toBe('agent.drift.paths.gone');
    expect(gone.componentPaths).toBeUndefined();
    expect(gone.draft).toBeUndefined();
  });
});

describe('the head overlay', () => {
  it('replaces a changed importer\'s rows and keeps the rows that import a removed file', () => {
    const base = [
      { importerPath: 'a.ts', importedPath: 'c.ts', names: ['x'] },
      { importerPath: 'b.ts', importedPath: 'gone.ts', names: ['y'] },
    ];
    const head = [{ importerPath: 'a.ts', importedPath: 'd.ts', names: ['z'] }];
    expect(overlayImports(base, head, ['a.ts'])).toEqual([base[1], head[0]]);
  });

  it('reads only the changed files at the head and follows their imports through an alias and a barrel', async () => {
    headFiles.clear();
    headFiles.set('apps/web/src/pages/New.vue', `<script setup lang="ts">\nimport { ResponsivePopover } from '@/components/ui/popover';\n</script>\n`);
    const enc = (s: string) => Buffer.from(s, 'utf8');
    const snapshotFiles = new Map<string, Uint8Array>([
      ['apps/web/tsconfig.json', enc('{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }')],
      [BARREL, enc("export { default as ResponsivePopover } from './ResponsivePopover.vue';\n")],
      [POPOVER, enc('<script setup lang="ts">\nconst open = true;\n</script>\n')],
      ['apps/web/src/pages/Old.vue', enc('<template />')],
    ]);
    const connectors = {
      require: async () => ({ id: 'c1', workspaceId: 'w', kind: 'codebase', enabled: true, name: 'app' }),
      contextFor: async () => ({ config: { repoUrl: 'https://github.com/acme/app' } }),
    };
    const snapshots = { open: async () => ({ files: snapshotFiles }) };
    const service = new PullRequestService(connectors as never, snapshots as never, new TreeSitterService());

    const head = await service.headImports('c1', 'w', pr.headSha, [
      { path: 'apps/web/src/pages/New.vue', previousPath: null, status: 'added', patch: null },
      { path: 'apps/web/src/pages/Old.vue', previousPath: null, status: 'removed', patch: null },
    ]);
    expect(head.unread).toBe(0);
    expect(head.replaced.sort()).toEqual(['apps/web/src/pages/New.vue', 'apps/web/src/pages/Old.vue']);
    expect(head.rows).toEqual(
      expect.arrayContaining([
        { importerPath: 'apps/web/src/pages/New.vue', importedPath: BARREL, names: ['ResponsivePopover'] },
        { importerPath: 'apps/web/src/pages/New.vue', importedPath: POPOVER, names: ['default'] },
      ]),
    );
    // The barrel was read to follow it, never indexed as a changed importer.
    expect(head.rows.every((r) => r.importerPath === 'apps/web/src/pages/New.vue')).toBe(true);
    expect(head.baseFiles.has('apps/web/src/pages/Old.vue')).toBe(true);
  });
});

describe('ComponentUsagesService.forChange', () => {
  const COMPONENT = 'd0000000-0000-4000-8000-000000000001';
  const PAGES = 'd0000000-0000-4000-8000-000000000002';
  const SECRET = 'd0000000-0000-4000-8000-000000000003';
  const titles: Record<string, string> = { [COMPONENT]: 'Responsive popover', [PAGES]: 'Web pages', [SECRET]: 'Admin pages' };
  const declarations = [
    { documentId: COMPONENT, componentKey: 'component:responsivepopover', paths: [POPOVER], symbols: ['ResponsivePopover'] },
    { documentId: PAGES, componentKey: 'component:pages', paths: ['apps/web/src/pages'], symbols: [] },
    { documentId: SECRET, componentKey: 'component:admin', paths: ['apps/web/src/admin'], symbols: [] },
  ];
  const base = [
    { importerPath: 'apps/web/src/admin/Users.vue', importedPath: POPOVER, names: ['default'] },
    { importerPath: 'apps/web/src/pages/Side.ts', importedPath: POPOVER, names: [] },
    { importerPath: 'apps/web/src/lib/menu.ts', importedPath: POPOVER, names: ['*'] },
  ];

  function service(visible: string[]) {
    const prisma = {
      componentDeclaration: { findMany: async () => declarations },
      connectorLink: { findMany: async () => [] },
      document: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.filter((id) => titles[id]).map((id) => ({ id, title: titles[id] })),
      },
      codeImport: { findMany: vi.fn(async () => base) },
    };
    const permissions = {
      visibleDocumentIds: async (_: unknown, ids: string[]) => new Set(ids.filter((id) => visible.includes(id))),
    };
    return new ComponentUsagesService(prisma as never, {} as never, permissions as never);
  }
  const scope = { workspaceId: 'w' } as never;
  const changed = [{ path: POPOVER, previousPath: null, status: 'modified' as const }];

  it('asks for nothing, the head included, when no declaration covers a changed file', async () => {
    const overlay = vi.fn(async () => null);
    expect(await service([]).forChange(scope, 'c1', [{ path: 'README.md', previousPath: null, status: 'modified' }], overlay)).toBeNull();
    expect(overlay).not.toHaveBeenCalled();
  });

  it('ties the declaring page, groups usages by documenting page, counts the hidden one and lists the undocumented', async () => {
    const overlay = async () => ({
      rows: [{ importerPath: 'apps/web/src/pages/New.vue', importedPath: POPOVER, names: ['default'] }],
      replaced: ['apps/web/src/pages/New.vue'],
      baseFiles: new Set([POPOVER]),
    });
    const impact = (await service([COMPONENT, PAGES]).forChange(scope, 'c1', changed, overlay))!;
    expect(impact.declared).toEqual([{ documentId: COMPONENT, title: 'Responsive popover', files: [POPOVER], paths: [POPOVER] }]);
    // Side.ts imports the file but not the symbol: not a usage. New.vue is the importer the pull request adds.
    expect(impact.affected).toEqual([{ documentId: PAGES, title: 'Web pages', sites: ['apps/web/src/pages/New.vue'], uses: [POPOVER] }]);
    expect(impact.hiddenPages).toBe(1);
    expect(JSON.stringify(impact)).not.toContain('Admin pages');
    expect(impact.undocumented).toEqual(['apps/web/src/lib/menu.ts']);
  });

  it('answers from the default branch when the head cannot be read', async () => {
    const impact = (await service([COMPONENT, PAGES, SECRET]).forChange(scope, 'c1', changed, async () => null))!;
    expect(impact.overlay).toBeNull();
    expect(impact.affected.map((a) => a.documentId)).toEqual([SECRET]);
  });
});

describe('the sentinel with component ties', () => {
  const affected = Array.from({ length: MAX_DRIFT_PAGES + 3 }, (_, i) => ({
    documentId: `u${i}`,
    title: `Usage page ${i}`,
    sites: [`apps/web/src/pages/P${i}.vue`],
    uses: [POPOVER],
  }));

  function sentinel(opts: { removed?: boolean; drifted?: boolean } = {}) {
    const file = opts.removed
      ? { path: POPOVER, previousPath: null, status: 'removed', patch: null }
      : { path: POPOVER, previousPath: null, status: 'modified', patch: '@@ -1 +1 @@' };
    const prisma = {
      connector: { findFirst: async () => ({ id: 'c1', name: 'app', kind: 'codebase', config: {}, projectId: 'p', parentId: null }) },
      connectorLink: { findMany: async () => [] },
      document: { findMany: async () => [] },
    };
    const componentUsages = {
      forChange: vi.fn(async () => ({
        declared: [{ documentId: 'decl', title: 'Responsive popover', files: [POPOVER], paths: [POPOVER, 'apps/web/src/components/ui/popover/index.ts'] }],
        affected,
        hiddenPages: 2,
        undocumented: ['apps/web/src/lib/menu.ts'],
        overlay: null,
      })),
    };
    const verdict = opts.drifted
      ? JSON.stringify({ drifted: true, severity: 'warning', title: 'Focus', detail: 'Says focus is lost.', markdown: null })
      : JSON.stringify({ drifted: false, severity: 'info', title: '', detail: '', markdown: null });
    const client = { chat: vi.fn(async () => verdict), runWithTools: vi.fn() };
    const executor = new AgentExecutor(
      prisma as never,
      {} as never,
      {} as never,
      client as never,
      { definitions: () => [], execute: vi.fn() } as never,
      { renderPrompt: () => '', forTurn: async () => [] } as never,
      { getContent: async () => ({ markdown: 'The popover keeps focus on the trigger.', frontmatter: {} }) } as never,
      {} as never,
      { definitions: () => [] } as never,
      {} as never,
      { files: async () => ({ files: [file], truncated: false }) } as never,
      { search: async () => ({ results: [] }) } as never,
      {} as never,
      { get: () => undefined } as never,
      {
        scopeFor: async (_p: unknown, workspaceId: string) => ({ workspaceId, bypass: true }),
        audienceScope: async (scope: unknown) => scope,
      } as never,
      { promptFor: async () => '', dismissedPrompt: async () => '' } as never,
      componentUsages as never,
      {} as never,
    );
    const run = {
      id: 'run-1',
      workspaceId: 'w',
      agentKey: 'sentinel',
      createdBy: 'u-owner',
      locale: 'en',
      input: { connectorId: 'c1', pullRequest: pr },
    } as unknown as AgentRun;
    const agent = {
      key: 'sentinel',
      instructions: 'judge',
      skillIds: [],
      config: { enabled: true },
      // No tool loop: one plain call per page, which is what the spy counts.
      missing: ['tools'],
    };
    return { executor, run, agent, client };
  }

  it('judges the declaring page first, then usage pages up to the cap, and lists the rest unjudged', async () => {
    const { executor, run, agent, client } = sentinel();
    const result = await executor.run(run, agent as never, { userId: 'u-owner' } as never, async () => undefined);
    expect(client.chat).toHaveBeenCalledTimes(MAX_DRIFT_PAGES);
    const pages = result.details!.affectedUsages!.pages;
    expect(pages).toHaveLength(affected.length);
    // One slot went to the declaring page.
    expect(pages.filter((p) => p.judged)).toHaveLength(MAX_DRIFT_PAGES - 1);
    expect(pages.slice(MAX_DRIFT_PAGES - 1).every((p) => !p.judged)).toBe(true);
    expect(result.details!.affectedUsages).toMatchObject({ hiddenPages: 2, undocumented: ['apps/web/src/lib/menu.ts'], undocumentedTotal: 1 });
    const firstPrompt = (client.chat.mock.calls[0] as unknown as [unknown, Array<{ content: string }>])[1][1].content;
    expect(firstPrompt).toContain('declares');
    expect(firstPrompt).toContain('documentId="decl"');
  });

  it('turns a removed declared file into a path fix, folded into the verdict on that page', async () => {
    const { executor, run, agent } = sentinel({ removed: true, drifted: true });
    const result = await executor.run(run, agent as never, { userId: 'u-owner' } as never, async () => undefined);
    const onDecl = result.findings.filter((f) => f.documentIds[0] === 'decl');
    expect(onDecl).toHaveLength(1);
    expect(onDecl[0].componentPaths).toEqual([{ from: POPOVER, to: null }]);
    expect(onDecl[0].detail).toContain('Says focus is lost.');
  });

  it('still reports the path fix when no model is configured', async () => {
    const { executor, run, agent, client } = sentinel({ removed: true });
    const result = await executor.run(run, { ...agent, config: { enabled: false } } as never, { userId: 'u-owner' } as never, async () => undefined);
    expect(client.chat).not.toHaveBeenCalled();
    expect(result.findings.find((f) => f.documentIds[0] === 'decl')?.componentPaths).toEqual([{ from: POPOVER, to: null }]);
    expect(result.details!.affectedUsages!.pages.every((p) => !p.judged)).toBe(true);
  });
});

describe('affectedUsagesDetails', () => {
  it('writes nothing when no usage was touched, and caps the undocumented list', () => {
    expect(affectedUsagesDetails(null, new Set())).toBeUndefined();
    expect(affectedUsagesDetails({ affected: [], hiddenPages: 0, undocumented: [] }, new Set())).toBeUndefined();
    const many = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
    const details = affectedUsagesDetails({ affected: [], hiddenPages: 0, undocumented: many }, new Set())!;
    expect(details.affectedUsages!.undocumented).toHaveLength(MAX_UNDOCUMENTED_SITES);
    expect(details.affectedUsages!.undocumentedTotal).toBe(30);
  });
});

describe('the Affected usages section', () => {
  const affected = {
    pages: [
      { documentId: 'p1', title: 'Web [pages]', sites: ['a.vue', 'b.vue', 'c.vue', 'd.vue'], uses: [POPOVER], judged: true },
      { documentId: 'p2', title: 'Admin', sites: ['admin/`x`.vue'], uses: [POPOVER], judged: false },
    ],
    hiddenPages: 1,
    undocumented: ['lib/menu.ts'],
    undocumentedTotal: 3,
  };

  it('groups usage files by page, marks the unjudged, counts the hidden and lists the undocumented', () => {
    const body = renderDriftComment({ webBaseUrl: 'https://kb.example', connectorName: 'app', pullRequest: pr, entries: [], affected });
    // Text is rendered through t(), which answers with the key in a spec.
    const lines = body.split('\n');
    expect(lines.slice(0, 5)).toEqual(['### agent.drift.comment.heading', '', 'agent.drift.comment.clean', '', '#### agent.drift.comment.usagesHeading']);
    expect(lines).toContain('- [Web \\[pages\\]](https://kb.example/documents/p1) — agent.drift.comment.andMore · agent.drift.comment.uses');
    // A backtick in a path cannot close the code span; the unread page says so.
    expect(lines).toContain('- [Admin](https://kb.example/documents/p2) — `admin/x.vue` · agent.drift.comment.uses · _agent.drift.comment.notChecked_');
    expect(lines).toContain('- agent.drift.comment.hiddenPages');
    expect(lines).toContain('- agent.drift.comment.undocumented');
    expect(lines.at(-1)).toBe('<sub>agent.drift.comment.footer</sub>');
  });

  it('leaves the section out when there is nothing to list', () => {
    const body = renderDriftComment({ webBaseUrl: 'https://kb.example', connectorName: 'app', pullRequest: pr, entries: [], affected: null });
    expect(body).not.toContain('Affected usages');
  });
});

describe('DriftPublishSweeper with component findings', () => {
  function sweeper(run: Partial<AgentRun>) {
    const findings = { propose: vi.fn(async () => ({ mergeRequestId: 'mr-1' })) };
    const prisma = {
      connector: {
        findUnique: async () => ({ id: 'c1', name: 'app', enabled: true, workspaceId: 'w', config: { driftCheck: 'propose', driftFlagPages: false } }),
      },
      agentRun: { findMany: async () => [] },
      mergeRequest: { findMany: async () => [] },
    };
    const access = {
      principalFor: async () => ({ userId: 'u-owner' }),
      requireRole: async () => undefined,
    };
    const connectors = { contextFor: async () => ({}) };
    const s = new DriftPublishSweeper(
      prisma as never,
      connectors as never,
      findings as never,
      access as never,
      { requestVerification: vi.fn() } as never,
      { get: () => 'https://kb.example' } as never,
    );
    const full = {
      id: 'run-1',
      workspaceId: 'w',
      createdBy: 'u-owner',
      createdAt: new Date(),
      locale: 'en',
      input: { connectorId: 'c1', pullRequest: pr },
      findings: [],
      details: null,
      ...run,
    } as unknown as AgentRun;
    return { s, full, findings };
  }

  it('comments on a pull request that only touched usages', async () => {
    vi.mocked(upsertPullRequestComment).mockClear();
    const details: AgentRunDetails = {
      affectedUsages: {
        pages: [{ documentId: 'p1', title: 'Web pages', sites: ['a.vue'], uses: [POPOVER], judged: true }],
        hiddenPages: 0,
        undocumented: [],
        undocumentedTotal: 0,
      },
    };
    const { s, full } = sweeper({ details: details as never });
    await (s as unknown as { publish(run: AgentRun): Promise<void> }).publish(full);
    expect(upsertPullRequestComment).toHaveBeenCalledTimes(1);
    expect(vi.mocked(upsertPullRequestComment).mock.calls[0][3]).toContain('agent.drift.comment.usagesHeading');
  });

  it('proposes a path fix that carries no drafted body', async () => {
    vi.mocked(upsertPullRequestComment).mockClear();
    const finding: AgentFinding = {
      kind: 'stale',
      severity: 'warning',
      title: 'paths',
      detail: 'moved',
      documentIds: ['decl'],
      documentTitles: ['Responsive popover'],
      componentPaths: [{ from: 'a.ts', to: 'b.ts' }],
    };
    const { s, full, findings } = sweeper({ findings: [finding] as never });
    await (s as unknown as { publish(run: AgentRun): Promise<void> }).publish(full);
    expect(findings.propose).toHaveBeenCalledWith('w', 'run-1', 0, { userId: 'u-owner' });
    expect(vi.mocked(upsertPullRequestComment).mock.calls[0][3]).toContain('merge-requests/mr-1');
  });
});

describe('proposing a path fix', () => {
  const current = {
    markdown: '# Popover\n\nKeeps focus.\n',
    frontmatter: { title: 'Popover', component: { paths: ['./src/old/b.ts', 'src/keep.ts'] } },
  };
  // No registry, client or budget: a path fix with no drafted body must never reach the drafter.
  const service = new AgentFindingsService(
    {} as never,
    {} as never,
    { getContent: async () => current } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  ) as unknown as { replacementFor(...args: unknown[]): Promise<string> };
  const finding = (over: Partial<AgentFinding> = {}): AgentFinding => ({
    kind: 'stale',
    severity: 'warning',
    title: 'paths',
    detail: 'moved',
    documentIds: ['d1'],
    documentTitles: ['Popover'],
    componentPaths: [{ from: 'src/old/b.ts', to: 'src/new/b.ts' }],
    ...over,
  });
  const doc = { id: 'd1', title: 'Popover', workspaceId: 'w' };

  it('rewrites component.paths and keeps the body, with no model', async () => {
    const text = await service.replacementFor(finding(), doc, 'w', { userId: 'u' }, 'en');
    expect(text).toContain('- src/new/b.ts');
    expect(text).toContain('- src/keep.ts');
    expect(text).not.toContain('src/old/b.ts');
    expect(text).toContain('Keeps focus.');
  });

  it('puts the edit under a drafted body too', async () => {
    const text = await service.replacementFor(finding({ draft: { title: 'Popover', markdown: '# Popover\n\nMoved and still keeps focus.' } }), doc, 'w', { userId: 'u' }, 'en');
    expect(text).toContain('- src/new/b.ts');
    expect(text).toContain('Moved and still keeps focus.');
  });

  it('refuses when the page no longer declares the path', async () => {
    await expect(
      service.replacementFor(finding({ componentPaths: [{ from: 'src/other.ts', to: null }] }), doc, 'w', { userId: 'u' }, 'en'),
    ).rejects.toThrow(/findingPathsCurrent|no longer declares/);
  });
});
