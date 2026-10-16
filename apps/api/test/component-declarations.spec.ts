import { describe, expect, it, vi } from 'vitest';
import { renderTemplateFrontmatter } from '@knowledge/contracts';
import { readComponentFrontmatter } from '../src/common/frontmatter.js';
import {
  componentKeyFor,
  componentUsageEdges,
  coversFile,
  pathCovers,
  resolveDeclaration,
  usesSymbols,
} from '../src/components/component-match.js';
import { extractFrontmatterFacts } from '../src/ingestion/relations.js';
import { parseTemplateSource } from '../src/templates/template-source.js';
import { BUILT_IN_TEMPLATES } from '../src/templates/built-in/index.js';
import { GraphService } from '../src/graph/graph.service.js';
import type { ArcadeClient } from '../src/graph/arcade.client.js';
import type { EntityAliasService } from '../src/graph/entity-alias.service.js';

/**
 * Component pages, phase 2 (#236): reading a `component:` block, resolving it
 * to a code connector, which imports count as a use, which pages document a
 * usage site, the built-in template, and the `code` edge writer.
 */

describe('readComponentFrontmatter', () => {
  it('is null without a block, and lenient about the shape of one', () => {
    expect(readComponentFrontmatter({ title: 'x' })).toBeNull();
    expect(readComponentFrontmatter({ component: { paths: './src/a.ts', symbols: 'A', repository: ' o/r ' } })).toEqual({
      repository: 'o/r',
      paths: ['src/a.ts'],
      symbols: ['A'],
      name: null,
    });
  });

  it('drops blank and duplicate entries, and keeps a block that declares no path', () => {
    expect(readComponentFrontmatter({ Component: { repository: '', paths: ['', '/a.ts', 'a.ts'], name: 'A' } })).toEqual({
      repository: null,
      paths: ['a.ts'],
      symbols: [],
      name: 'A',
    });
    expect(readComponentFrontmatter({ component: 'x' })?.paths).toEqual([]);
  });
});

describe('path and symbol matching', () => {
  it('covers a file by its path, a directory above it, or a glob', () => {
    expect(pathCovers('src/a.ts', 'src/a.ts')).toBe(true);
    expect(pathCovers('src', 'src/x/a.ts')).toBe(true);
    expect(pathCovers('src/', 'src/a.ts')).toBe(true);
    expect(pathCovers('src', 'srcx/a.ts')).toBe(false);
    expect(pathCovers('src/*.ts', 'src/a.ts')).toBe(true);
    expect(pathCovers('src/*.ts', 'src/x/a.ts')).toBe(false);
    expect(pathCovers('src/**/*.vue', 'src/a.vue')).toBe(true);
    expect(pathCovers('src/**/*.vue', 'src/x/y/a.vue')).toBe(true);
    expect(pathCovers('src/a.ts', 'src/a.tsx')).toBe(false);
    expect(coversFile([], 'a.ts')).toBe(false);
  });

  it('counts a named, namespace or file-named default import as a use of a symbol, never a side-effect import', () => {
    expect(usesSymbols([], [], 'a.ts')).toBe(true);
    expect(usesSymbols(['HEALTH_FILTERS'], ['HEALTH_FILTERS', 'x'], 'core/index.ts')).toBe(true);
    expect(usesSymbols(['HEALTH_FILTERS'], ['other'], 'core/index.ts')).toBe(false);
    expect(usesSymbols(['HEALTH_FILTERS'], ['*'], 'core/index.ts')).toBe(true);
    expect(usesSymbols(['ResponsivePopover'], ['default'], 'ui/ResponsivePopover.vue')).toBe(true);
    expect(usesSymbols(['Other'], ['default'], 'ui/ResponsivePopover.vue')).toBe(false);
    expect(usesSymbols(['A'], [], 'a.ts')).toBe(false);
  });
});

describe('componentKeyFor', () => {
  const block = { repository: null, paths: ['a.ts'], symbols: [], name: null };
  it('takes component.name, then the DESCRIBES component relation, then the title — folded', () => {
    expect(componentKeyFor({ ...block, name: 'Responsive Popover' }, {}, 'T')).toEqual({
      key: 'component:responsive-popover',
      name: 'Responsive Popover',
    });
    const fm = { relations: [{ type: 'describes', target: 'component:ResponsivePopover' }] };
    expect(componentKeyFor(block, fm, 'T')).toEqual({ key: 'component:responsivepopover', name: 'ResponsivePopover' });
    expect(componentKeyFor(block, { relations: [{ type: 'DESCRIBES', target: 'service:x' }] }, 'Popover')).toEqual({
      key: 'component:popover',
      name: 'Popover',
    });
  });
});

describe('resolveDeclaration', () => {
  const one = [{ id: 'c1', repoUrl: 'https://github.com/Hrustalq/Knowledge.git' }];
  const two = [...one, { id: 'c2', repoUrl: 'https://github.com/acme/web' }];
  const paths = ['a.ts'];

  it('needs a path and a connector', () => {
    expect(resolveDeclaration({ repository: null, paths: [] }, one)).toEqual({ connectorId: null, warning: 'no-paths' });
    expect(resolveDeclaration({ repository: null, paths }, [])).toEqual({ connectorId: null, warning: 'no-connector' });
  });

  it('takes the only connector when the page names none, and refuses to guess between several', () => {
    expect(resolveDeclaration({ repository: null, paths }, one)).toEqual({ connectorId: 'c1', warning: null });
    expect(resolveDeclaration({ repository: null, paths }, two)).toEqual({ connectorId: null, warning: 'ambiguous-repository' });
  });

  it('matches owner/repo, a bare repo name or a URL, case-insensitively', () => {
    for (const repository of ['hrustalq/knowledge', 'knowledge', 'https://github.com/hrustalq/knowledge', 'github.com/HRUSTALQ/knowledge.git']) {
      expect(resolveDeclaration({ repository, paths }, two)).toEqual({ connectorId: 'c1', warning: null });
    }
  });

  it('warns on a repository no connector reads, and on one several do', () => {
    expect(resolveDeclaration({ repository: 'acme/api', paths }, two)).toEqual({ connectorId: null, warning: 'unknown-repository' });
    const same = [...one, { id: 'c3', repoUrl: 'https://github.com/hrustalq/knowledge' }];
    expect(resolveDeclaration({ repository: 'hrustalq/knowledge', paths }, same)).toEqual({
      connectorId: null,
      warning: 'ambiguous-repository',
    });
  });
});

describe('componentUsageEdges', () => {
  const popover = { documentId: 'p-popover', componentKey: 'component:popover', paths: ['web/ui/Popover.vue'], symbols: [] };
  const card = { documentId: 'p-card', componentKey: 'component:card', paths: ['web/ui/card/'], symbols: [] };
  const modules = [
    { dir: 'web', documentId: 'm-web' },
    { dir: 'web/pages', documentId: 'm-pages' },
  ];
  const row = (importerPath: string, importedPath: string, names: string[] = ['default']) => ({ importerPath, importedPath, names });

  it('ties a usage site to the component pages covering it, else to its deepest module page', () => {
    const edges = componentUsageEdges(
      [popover, card],
      [
        row('web/pages/Doc.vue', 'web/ui/Popover.vue'),
        row('web/pages/List.vue', 'web/ui/Popover.vue'),
        row('web/ui/card/Card.vue', 'web/ui/Popover.vue'),
        row('web/main.ts', 'web/ui/Popover.vue'),
        row('web/pages/Doc.vue', 'web/ui/other.ts'),
      ],
      modules,
    );
    expect(Object.fromEntries([...edges].map(([page, byKey]) => [page, Object.fromEntries(byKey)]))).toEqual({
      'm-pages': { 'component:popover': ['web/pages/Doc.vue', 'web/pages/List.vue'] },
      'p-card': { 'component:popover': ['web/ui/card/Card.vue'] },
      'm-web': { 'component:popover': ['web/main.ts'] },
    });
  });

  it('ignores the component using itself, and never makes a page its own dependent', () => {
    const self = { ...card, documentId: 'p-card', paths: ['web/ui/card/', 'web/ui/Popover.vue'], componentKey: 'component:card' };
    const edges = componentUsageEdges([self], [row('web/ui/card/Card.vue', 'web/ui/Popover.vue')], modules);
    expect(edges.size).toBe(0);
    const covered = componentUsageEdges([popover, { ...card, paths: ['web/ui/'] }], [row('web/ui/X.vue', 'web/ui/Popover.vue')], modules);
    expect([...covered.keys()]).toEqual(['p-card']);
  });

  it('with symbols declared, a file importing the module but not the symbol is no usage', () => {
    const core = { documentId: 'p-core', componentKey: 'component:health', paths: ['contracts/core/index.ts'], symbols: ['HEALTH_FILTERS'] };
    const edges = componentUsageEdges(
      [core],
      [row('web/pages/A.vue', 'contracts/core/index.ts', ['HEALTH_FILTERS']), row('web/pages/B.vue', 'contracts/core/index.ts', ['Locale'])],
      modules,
    );
    expect(edges.get('m-pages')?.get('component:health')).toEqual(['web/pages/A.vue']);
  });
});

describe('the component template', () => {
  it.each(['en', 'ru'] as const)('(%s) renders a block the reader resolves, with a blank repository read as none', (locale) => {
    const parsed = parseTemplateSource(BUILT_IN_TEMPLATES.component.text[locale].source);
    const fm = renderTemplateFrontmatter(
      parsed.data,
      parsed.meta,
      { name: 'ResponsivePopover', path: 'apps/web/src/components/ResponsivePopover.vue' },
      { locale, title: 'Popover' },
    );
    const block = readComponentFrontmatter(fm)!;
    expect(block).toEqual({
      repository: null,
      paths: ['apps/web/src/components/ResponsivePopover.vue'],
      symbols: [],
      name: null,
    });
    expect(componentKeyFor(block, fm, 'Popover').key).toBe('component:responsivepopover');
    expect(extractFrontmatterFacts(fm)).toContainEqual({
      type: 'DESCRIBES',
      target: { key: 'component:responsivepopover', type: 'component', name: 'ResponsivePopover' },
    });
  });
});

describe('code edges', () => {
  function graph() {
    const commands: Array<{ sql: string; params?: Record<string, unknown> }> = [];
    const arcade = {
      query: vi.fn(async () => []),
      command: vi.fn(async (_lang: string, sql: string, params?: Record<string, unknown>) => {
        commands.push({ sql, params });
        return [];
      }),
    };
    const aliases = { resolveAll: vi.fn(async (_ws: string, keys: string[]) => keys) };
    return { graph: new GraphService(arcade as unknown as ArcadeClient, aliases as unknown as EntityAliasService), commands };
  }

  it('an author cannot write one: a frontmatter relation carries no extractor of its own', () => {
    const facts = extractFrontmatterFacts({
      relations: [{ type: 'DEPENDS_ON', target: 'component:popover', extractor: 'code' }],
    });
    expect(facts).toEqual([{ type: 'DEPENDS_ON', target: { key: 'component:popover', type: 'component', name: 'popover' } }]);
  });

  it('replaces only code edges, writes them document-level and folded, and re-running replaces rather than adds', async () => {
    const { graph: g, commands } = graph();
    const edges = [
      { documentId: 'd1', title: 'Pages', componentKey: 'Component:Popover', componentName: 'Popover', usages: ['a.vue', 'b.vue'] },
    ];
    await g.replaceCodeFacts({ workspaceId: 'w1', edges });
    await g.replaceCodeFacts({ workspaceId: 'w1', edges });
    const deletes = commands.filter((c) => c.sql.startsWith('DELETE'));
    expect(deletes.map((c) => c.sql)).toEqual([
      "DELETE FROM DEPENDS_ON WHERE workspaceId = :workspaceId AND extractor = 'code'",
      "DELETE FROM DEPENDS_ON WHERE workspaceId = :workspaceId AND extractor = 'code'",
    ]);
    const creates = commands.filter((c) => c.sql.startsWith('CREATE EDGE'));
    expect(creates).toHaveLength(2);
    expect(creates[0].sql).toContain('CREATE EDGE DEPENDS_ON');
    expect(creates[0].params).toMatchObject({
      documentId: 'd1',
      key: 'component:popover',
      revisionId: null,
      live: true,
      extractor: 'code',
      snippet: 'a.vue, b.vue',
    });
    // The delete runs before the create each time, so the second call cannot stack a copy.
    const order = commands.map((c) => c.sql.split(' ')[0]);
    expect(order.lastIndexOf('DELETE')).toBeLessThan(order.lastIndexOf('CREATE'));
    // The vertex keeps the page's spelling.
    expect(commands.find((c) => c.sql.startsWith('UPDATE Entity'))?.params).toMatchObject({ name: 'Popover', entityType: 'component' });
  });
});
