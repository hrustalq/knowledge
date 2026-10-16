import { describe, expect, it } from 'vitest';
import { importedPathPrefilter, usageSites, type ImportRow } from '../src/components/component-match.js';
import { ComponentUsagesService } from '../src/components/component-usages.service.js';
import type { ComponentsService } from '../src/components/components.service.js';
import type { AccessScope } from '../src/permissions/access-scope.js';
import type { PermissionService } from '../src/permissions/permission.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * Component pages, phase 3 (#236): which files use a component, and which
 * pages documenting them a caller is told about.
 */

const POPOVER = 'apps/web/src/components/ui/popover/ResponsivePopover.vue';

const ROWS: ImportRow[] = [
  { importerPath: 'apps/web/src/pages/A.vue', importedPath: POPOVER, names: ['default'] },
  { importerPath: 'apps/web/src/pages/B.vue', importedPath: 'apps/web/src/components/ui/popover/index.ts', names: ['Popover'] },
  { importerPath: 'apps/web/src/components/ui/popover/index.ts', importedPath: POPOVER, names: ['default'] },
  { importerPath: 'apps/web/src/lib/side.ts', importedPath: POPOVER, names: [] },
  { importerPath: 'apps/api/src/x.ts', importedPath: 'packages/contracts/src/core/index.ts', names: ['HEALTH_FILTERS'] },
  { importerPath: 'apps/web/src/y.ts', importedPath: 'packages/contracts/src/core/index.ts', names: ['labelFor'] },
];

describe('usageSites', () => {
  it('lists importers of the declared files, never a file inside the component', () => {
    const sites = usageSites(['apps/web/src/components/ui/popover'], [], ROWS);
    expect(sites.map((s) => s.path)).toEqual(['apps/web/src/lib/side.ts', 'apps/web/src/pages/A.vue', 'apps/web/src/pages/B.vue']);
  });

  it('with symbols, keeps only uses taking one — a default import counts for a file named like the symbol', () => {
    const sites = usageSites([POPOVER], ['ResponsivePopover'], ROWS);
    expect(sites.map((s) => s.path)).toEqual(['apps/web/src/components/ui/popover/index.ts', 'apps/web/src/pages/A.vue']);
    expect(usageSites(['packages/contracts/src/core/index.ts'], ['HEALTH_FILTERS'], ROWS).map((s) => s.path)).toEqual([
      'apps/api/src/x.ts',
    ]);
  });

  it('groups several imports of one file under one site', () => {
    const rows: ImportRow[] = [
      { importerPath: 'a.ts', importedPath: 'lib/z.ts', names: ['z'] },
      { importerPath: 'a.ts', importedPath: 'lib/b.ts', names: ['*'] },
    ];
    expect(usageSites(['lib'], [], rows)).toEqual([
      { path: 'a.ts', imports: [{ path: 'lib/b.ts', names: ['*'] }, { path: 'lib/z.ts', names: ['z'] }] },
    ]);
  });
});

describe('importedPathPrefilter', () => {
  it('narrows to files and directory prefixes, and reads everything for a glob', () => {
    expect(importedPathPrefilter(['src/a.ts', 'lib/'])).toEqual([
      { equals: 'src/a.ts' },
      { startsWith: 'src/a.ts/' },
      { equals: 'lib' },
      { startsWith: 'lib/' },
    ]);
    expect(importedPathPrefilter(['src/**/*.vue'])).toBeNull();
  });
});

describe('ComponentUsagesService', () => {
  const COMPONENT = 'c0000000-0000-4000-8000-000000000001';
  const PAGES_DOC = 'c0000000-0000-4000-8000-000000000002';
  const SECRET_DOC = 'c0000000-0000-4000-8000-000000000003';
  const WIKI_DOC = 'c0000000-0000-4000-8000-000000000004';
  const ARCHIVED_DOC = 'c0000000-0000-4000-8000-000000000005';
  const CONNECTOR = 'c0000000-0000-4000-8000-0000000000aa';

  const declarations = [
    { documentId: COMPONENT, componentKey: 'component:responsivepopover', paths: [POPOVER], symbols: [] },
    { documentId: PAGES_DOC, componentKey: 'component:pages', paths: ['apps/web/src/pages'], symbols: [] },
    { documentId: SECRET_DOC, componentKey: 'component:page-a', paths: ['apps/web/src/pages/A.vue'], symbols: [] },
    { documentId: ARCHIVED_DOC, componentKey: 'component:old', paths: ['apps/web/src/lib'], symbols: [] },
  ];
  const titles: Record<string, string> = {
    [COMPONENT]: 'Responsive popover',
    [PAGES_DOC]: 'Web pages',
    [SECRET_DOC]: 'Secret page A',
    [WIKI_DOC]: 'apps/web',
  };

  function service(opts: { visible: string[]; view?: Record<string, unknown> | null }) {
    const prisma = {
      connector: { findUnique: async () => ({ id: CONNECTOR, name: 'This repo' }) },
      codeImport: {
        findMany: async () => ROWS.map((r) => ({ ...r, headSha: 'abc123' })),
        findFirst: async () => ({ headSha: 'abc123' }),
      },
      componentDeclaration: { findMany: async () => declarations },
      connectorLink: { findMany: async () => [{ externalId: 'module:apps/web', documentId: WIKI_DOC }] },
      // Archived pages are filtered by the query; the stub drops the one archived row.
      document: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.filter((id) => titles[id]).map((id) => ({ id, title: titles[id] })),
      },
    } as unknown as PrismaService;
    const components = {
      view: async () =>
        opts.view === undefined
          ? { documentId: COMPONENT, connector: { id: CONNECTOR, name: 'This repo' }, paths: [POPOVER], symbols: [], warning: null }
          : opts.view,
      codeConnectors: async () => [{ id: CONNECTOR, repoUrl: 'https://github.com/hrustalq/knowledge' }],
    } as unknown as ComponentsService;
    const permissions = {
      visibleDocumentIds: async (_: AccessScope, ids: string[]) => new Set(ids.filter((id) => opts.visible.includes(id))),
    } as unknown as PermissionService;
    return new ComponentUsagesService(prisma, components, permissions);
  }

  const scope = { workspaceId: 'w' } as AccessScope;

  it('lists every usage path, titles only the pages the caller may open, and counts the rest', async () => {
    const res = await service({ visible: [PAGES_DOC, WIKI_DOC] }).forDocument(scope, COMPONENT);
    expect(res.connector).toEqual({ id: CONNECTOR, name: 'This repo' });
    expect(res.headSha).toBe('abc123');
    expect(res.usages.map((u) => u.path)).toEqual([
      'apps/web/src/components/ui/popover/index.ts',
      'apps/web/src/lib/side.ts',
      'apps/web/src/pages/A.vue',
    ]);
    const a = res.usages.find((u) => u.path === 'apps/web/src/pages/A.vue')!;
    expect(a.pages).toEqual([{ id: PAGES_DOC, title: 'Web pages' }]);
    expect(a.hiddenPages).toBe(1);
    expect(JSON.stringify(res)).not.toContain('Secret page A');
    // The archived page's declaration covers lib/, so the wiki module page answers instead.
    expect(res.usages.find((u) => u.path === 'apps/web/src/lib/side.ts')!.pages).toEqual([{ id: WIKI_DOC, title: 'apps/web' }]);
  });

  it('never lists the asking page as documenting its own usages', async () => {
    const res = await service({ visible: [COMPONENT, PAGES_DOC, SECRET_DOC, WIKI_DOC] }).forDocument(scope, COMPONENT);
    expect(res.components).toEqual([]);
    expect(res.usages.flatMap((u) => u.pages.map((p) => p.id))).not.toContain(COMPONENT);
  });

  it('answers a path with the component pages covering it, and agrees with the page answer', async () => {
    const svc = service({ visible: [COMPONENT, PAGES_DOC, WIKI_DOC] });
    const byPath = await svc.forPath(scope, { path: POPOVER });
    expect(byPath.components).toEqual([{ id: COMPONENT, title: 'Responsive popover' }]);
    const byPage = await svc.forDocument(scope, COMPONENT);
    expect(byPath.usages).toEqual(byPage.usages);
  });

  it('counts sites past the limit instead of listing them', async () => {
    const res = await service({ visible: [] }).forDocument(scope, COMPONENT, { limit: 1 });
    expect(res.usages).toHaveLength(1);
    expect(res.truncated).toBe(2);
  });

  it('answers empty, with the warning, for a declaration that resolved to no connector', async () => {
    const res = await service({
      visible: [],
      view: { documentId: COMPONENT, connector: null, paths: [POPOVER], symbols: [], warning: 'unknown-repository' },
    }).forDocument(scope, COMPONENT);
    expect(res).toMatchObject({ connector: null, usages: [], warning: 'unknown-repository' });
  });

  it('refuses a page that declares no component', async () => {
    await expect(service({ visible: [], view: null }).forDocument(scope, COMPONENT)).rejects.toThrow(/notDeclared|declares no component/);
  });

  it('picks the connector for a path like a declaration does', async () => {
    const res = await service({ visible: [] }).forPath(scope, { path: POPOVER, repository: 'someone/else' });
    expect(res).toMatchObject({ connector: null, warning: 'unknown-repository' });
  });
});
