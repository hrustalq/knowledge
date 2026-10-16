import { describe, expect, it, vi } from 'vitest';

/**
 * The code-usage index, phase 1 (#236): import names off real trees, the
 * file → file resolver (relative, `tsconfig` paths with `extends`, workspace
 * packages through `exports`), the adapter's whole-archive walk, and the
 * replace-per-pull store. The archive download is the seam; tree-sitter runs
 * for real.
 */
vi.mock('../src/connectors/adapters/repo-archive.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/connectors/adapters/repo-archive.js')>();
  return { ...real, downloadRepoArchive: vi.fn() };
});

const { downloadRepoArchive } = await import('../src/connectors/adapters/repo-archive.js');
const { CodebaseAdapter } = await import('../src/connectors/adapters/codebase.adapter.js');
const { TreeSitterService } = await import('../src/connectors/adapters/tree-sitter.service.js');
const { extractImports } = await import('../src/connectors/adapters/code-symbols.js');
const { createFileResolver, stripJsonc } = await import('../src/connectors/adapters/import-resolver.js');
const { CodeImportsService } = await import('../src/connectors/code-imports.service.js');
const download = vi.mocked(downloadRepoArchive);

const enc = new TextEncoder();
const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, text]) => [path, enc.encode(text)]));
const json = (value: unknown) => JSON.stringify(value);

const REPO: Record<string, string> = {
  'package.json': json({ name: 'root', private: true }),
  'tsconfig.base.json': '{\n  // shared by the backends\n  "compilerOptions": {\n    "paths": { "#shared/*": ["./packages/shared/src/*"], },\n  },\n}\n',

  'apps/api/tsconfig.json': json({ extends: '../../tsconfig.base.json', compilerOptions: { strict: true } }),
  'apps/api/src/main.ts': [
    "import express from 'express';",
    "import { UsersService } from './users.js';",
    "import { slug } from '#shared/util';",
    "import { HEALTH_FILTERS, type HealthFilter } from '@knowledge/contracts/core';",
    "import * as contracts from '@knowledge/contracts';",
    "import '@/nope';",
    'export const app = 1;',
  ].join('\n'),
  'apps/api/src/users.ts': 'export class UsersService {}\n',

  // A Vite app: the root config only references the others, which carry the alias.
  'apps/web/tsconfig.json': json({ files: [], references: [{ path: './tsconfig.app.json' }] }),
  'apps/web/tsconfig.app.json': json({ extends: '@vue/tsconfig/tsconfig.dom.json', compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
  'apps/web/src/components/Popover.vue': '<template><div /></template>\n<script setup lang="ts">\ndefineProps<{ open: boolean }>();\n</script>\n',
  'apps/web/src/lib/format.ts': 'export function formatDate(): string { return ""; }\nexport function formatBytes(): string { return ""; }\n',
  'apps/web/src/App.vue': [
    '<script lang="ts">',
    "export { formatBytes } from '@/lib/format';",
    '</script>',
    '<script setup lang="ts">',
    "import Popover from '@/components/Popover.vue';",
    "import { formatDate } from '@/lib/format';",
    "import { HEALTH_FILTERS } from '@knowledge/contracts/core';",
    '</script>',
    '<template><Popover /></template>',
  ].join('\n'),
  'apps/web/src/router.ts': "export const routes = [{ path: '/', component: () => import('@/App.vue') }];\n",
  // A shadcn-style barrel: consumers import the component by name from the directory.
  'apps/web/src/components/ui/index.ts': [
    "export { default as Popover } from '../Popover.vue';",
    "export { default as Tip } from './Tip.vue';",
    "export * as fmt from '../../lib/format';",
  ].join('\n'),
  'apps/web/src/components/ui/Tip.vue': '<template><span /></template>\n',
  'apps/web/src/pages/Home.vue': "<script setup lang=\"ts\">\nimport { Popover } from '@/components/ui';\n</script>\n",
  'apps/web/src/pages/Ns.ts': "import * as ui from '@/components/ui';\nimport '@/components/ui';\nexport const n = ui;\n",

  'packages/shared/src/util.ts': 'export const slug = (s: string) => s;\n',
  'packages/contracts/package.json': json({
    name: '@knowledge/contracts',
    exports: { '.': './src/index.ts', './core': './src/core/index.ts' },
  }),
  'packages/contracts/src/index.ts': "export * from './core/index.js';\nexport * from './cycle.js';\n",
  'packages/contracts/src/core/index.ts':
    "export const HEALTH_FILTERS = ['stale'] as const;\nexport type HealthFilter = string;\nconst local = 1;\nexport { local as renamed };\nexport default 1;\n",
  // `export *` cycles must end.
  'packages/contracts/src/cycle.ts': "export * from './index.js';\nexport const cyc = 1;\n",
  'apps/api/src/health.ts': "import { HEALTH_FILTERS, renamed, cyc } from '@knowledge/contracts';\nimport def from '@knowledge/contracts';\n",
  'packages/contracts/src/hidden.ts': 'export const hidden = 1;\n',
  'packages/legacy/package.json': json({ name: 'legacy', main: './lib/main.js' }),
  'packages/legacy/lib/main.ts': 'export const legacy = 1;\n',
  'packages/pattern/package.json': json({
    name: 'pattern',
    exports: { './*': { types: './dist/*.d.ts', import: './src/*.ts' } },
  }),
  'packages/pattern/src/a.ts': 'export const a = 1;\n',

  'svc/pkg/__init__.py': 'VERSION = 1\n',
  'svc/pkg/a.py': 'def x():\n    pass\n',
  'svc/pkg/sub/b.py': 'from ..a import x\nfrom .. import a, VERSION\nimport os\n',
};

async function importsOf(language: 'typescript' | 'python', source: string) {
  return new TreeSitterService().withTree(language, source, (tree) => extractImports(language, tree));
}

describe('extractImports', () => {
  it('records the names each ECMAScript import and re-export takes', async () => {
    const refs = await importsOf(
      'typescript',
      [
        "import D, { A, B as C, type T } from './a';",
        "import * as NS from './b';",
        "import './c';",
        "export { E, F as G } from './e';",
        "export * from './f';",
        "export * as H from './g';",
        'export const local = 1;',
        "async function load() { return import('./lazy'); }",
      ].join('\n'),
    );
    expect(refs).toEqual([
      { specifier: './a', names: ['A', 'B', 'T', 'default'] },
      { specifier: './b', names: ['*'] },
      { specifier: './c', names: [] },
      { specifier: './e', names: ['E', 'F'], reexport: { star: false, names: { E: 'E', G: 'F' } } },
      { specifier: './f', names: ['*'], reexport: { star: true, names: {} } },
      { specifier: './g', names: ['*'], reexport: { star: false, names: { H: '*' } } },
      { specifier: './lazy', names: ['*'] },
    ]);
  });

  it('yields Python relative imports with their names, and no absolute ones', async () => {
    const refs = await importsOf('python', 'from .mod import a, b as c\nfrom .. import pkg\nfrom . import *\nimport os\n');
    expect(refs).toEqual([
      { specifier: '.mod', names: ['a', 'b'] },
      { specifier: '..', names: ['pkg'] },
      { specifier: '.', names: ['*'] },
    ]);
  });
});

describe('createFileResolver', () => {
  const resolve = createFileResolver(files(REPO));
  const main = 'apps/api/src/main.ts';

  it('resolves a relative NodeNext import to its source file', () => {
    expect(resolve(main, './users.js')).toBe('apps/api/src/users.ts');
  });

  it('resolves a `paths` alias declared in an `extends`d config', () => {
    expect(resolve(main, '#shared/util')).toBe('packages/shared/src/util.ts');
  });

  it('reads the alias from a sibling tsconfig when the root config only references it', () => {
    expect(resolve('apps/web/src/App.vue', '@/components/Popover.vue')).toBe('apps/web/src/components/Popover.vue');
    expect(resolve('apps/web/src/router.ts', '@/lib/format')).toBe('apps/web/src/lib/format.ts');
  });

  it('resolves a workspace package through its `exports` map, and nothing it does not export', () => {
    expect(resolve(main, '@knowledge/contracts/core')).toBe('packages/contracts/src/core/index.ts');
    expect(resolve(main, '@knowledge/contracts')).toBe('packages/contracts/src/index.ts');
    expect(resolve(main, '@knowledge/contracts/hidden')).toBeNull();
  });

  it('falls back to `main`, and tries every condition of a subpath pattern', () => {
    expect(resolve(main, 'legacy')).toBe('packages/legacy/lib/main.ts');
    expect(resolve(main, 'pattern/a')).toBe('packages/pattern/src/a.ts');
  });

  it('drops what is not in the repository', () => {
    expect(resolve(main, 'express')).toBeNull();
    expect(resolve(main, '@/nope')).toBeNull(); // the api has no `@` alias
    expect(resolve(main, 'node:fs')).toBeNull();
    expect(resolve(main, './missing')).toBeNull();
  });

  it('resolves Python relative imports only', () => {
    expect(resolve('svc/pkg/sub/b.py', '..a')).toBe('svc/pkg/a.py');
    expect(resolve('svc/pkg/sub/b.py', '..')).toBe('svc/pkg/__init__.py');
    expect(resolve('svc/pkg/sub/b.py', 'os')).toBeNull();
  });

  it('strips comments and trailing commas but not slashes inside strings', () => {
    expect(JSON.parse(stripJsonc('{ "a": "http://x/*y*/", // c\n "b": [1,], }'))).toEqual({ a: 'http://x/*y*/', b: [1] });
  });
});

function adapter() {
  return new CodebaseAdapter(
    new TreeSitterService(),
    {} as never,
    {} as never,
    {} as never,
    { get: () => 'medium' } as never,
  );
}

function ctx() {
  return {
    connectorId: 'c1',
    workspaceId: 'w1',
    config: { repoUrl: 'https://github.com/acme/demo', branch: 'main' },
    credential: null,
    onStage: async () => undefined,
    debug: () => undefined,
    allowPrivate: false,
    userId: null,
    locale: 'en' as const,
  };
}

describe('CodebaseAdapter.codeImports', () => {
  it('indexes every importer with the names it takes, single-file components included', async () => {
    download.mockResolvedValue({ files: files(REPO), skipped: { oversize: 0, binary: 0 }, branch: 'main', headSha: 'abc' });
    const index = await adapter().codeImports(ctx());
    const into = (path: string) =>
      Object.fromEntries(index.edges.filter((e) => e.imported === path).map((e) => [e.importer, e.names]));

    expect(index.headSha).toBe('abc');
    expect(into('packages/contracts/src/core/index.ts')).toEqual({
      // `import * as contracts` from the root barrel takes everything behind it.
      'apps/api/src/main.ts': ['*', 'HEALTH_FILTERS', 'HealthFilter'],
      'apps/web/src/App.vue': ['HEALTH_FILTERS'],
      'packages/contracts/src/index.ts': ['*'],
      'packages/contracts/src/cycle.ts': ['*'],
      // Through the root barrel's `export *`, by name; `default` is not carried by a star.
      'apps/api/src/health.ts': ['HEALTH_FILTERS', 'renamed'],
    });
    // cycle.ts star-re-exports the root back, so it too passes those names on — and the walk ends.
    expect(into('packages/contracts/src/cycle.ts')['apps/api/src/health.ts']).toEqual(['HEALTH_FILTERS', 'cyc', 'renamed']);
    expect(into('packages/contracts/src/index.ts')['apps/api/src/health.ts']).toEqual(['HEALTH_FILTERS', 'cyc', 'default', 'renamed']);
    // Through a named barrel, as the name the component file knows: `default`.
    expect(into('apps/web/src/components/Popover.vue')).toEqual({
      'apps/web/src/App.vue': ['default'],
      'apps/web/src/components/ui/index.ts': ['default'],
      'apps/web/src/pages/Home.vue': ['default'],
      'apps/web/src/pages/Ns.ts': ['default'],
    });
    // Home takes Popover only; the namespace import takes everything the barrel re-exports.
    expect(into('apps/web/src/components/ui/Tip.vue')).toEqual({
      'apps/web/src/components/ui/index.ts': ['default'],
      'apps/web/src/pages/Ns.ts': ['default'],
    });
    // Both script blocks of one file fold into one row.
    expect(into('apps/web/src/lib/format.ts')).toEqual({
      'apps/web/src/App.vue': ['formatBytes', 'formatDate'],
      'apps/web/src/components/ui/index.ts': ['*'],
      'apps/web/src/pages/Ns.ts': ['*'],
      // The lazy route takes App.vue whole, and App.vue re-exports formatBytes.
      'apps/web/src/router.ts': ['formatBytes'],
    });
    expect(into('apps/web/src/App.vue')).toEqual({ 'apps/web/src/router.ts': ['*'] });
    // `from .. import a, VERSION`: `a` is a sibling module, VERSION lives in __init__.
    expect(into('svc/pkg/a.py')).toEqual({ 'svc/pkg/sub/b.py': ['*', 'x'] });
    expect(into('svc/pkg/__init__.py')).toEqual({ 'svc/pkg/sub/b.py': ['VERSION'] });
    expect(index.edges.some((e) => e.imported.includes('express') || e.imported === e.importer)).toBe(false);
  });

  it('is not capped by the per-module parse sample', async () => {
    const many: Record<string, string> = { ...REPO };
    for (let i = 0; i < 205; i += 1) many[`apps/api/src/gen/f${i}.ts`] = "import { UsersService } from '../users.js';\n";
    download.mockResolvedValue({ files: files(many), skipped: { oversize: 0, binary: 0 }, branch: 'main', headSha: 'abc' });
    const index = await adapter().codeImports(ctx());
    expect(index.edges.filter((e) => e.imported === 'apps/api/src/users.ts')).toHaveLength(206);
  });
});

describe('CodeImportsService', () => {
  type Row = { connectorId: string; headSha: string | null; importerPath: string };
  function store() {
    let rows: Row[] = [];
    const tx = {
      codeImport: {
        deleteMany: async ({ where }: { where: { connectorId: string } }) => {
          rows = rows.filter((r) => r.connectorId !== where.connectorId);
        },
        createMany: async ({ data }: { data: Row[] }) => {
          rows.push(...data);
        },
      },
    };
    const prisma = { $transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx) };
    return { service: new CodeImportsService(prisma as never), rows: () => rows };
  }
  const edge = (importer: string) => ({ importer, imported: 'x.ts', names: [] });

  it("leaves only the latest head's rows, and other connectors' alone", async () => {
    const { service, rows } = store();
    await service.replace({ id: 'other', workspaceId: 'w1' }, { headSha: 'z', edges: [edge('o.ts')] });
    await service.replace({ id: 'c1', workspaceId: 'w1' }, { headSha: 'a', edges: [edge('a.ts'), edge('b.ts')] });
    expect(await service.replace({ id: 'c1', workspaceId: 'w1' }, { headSha: 'b', edges: [edge('c.ts')] })).toBe(1);
    expect(rows().map((r) => `${r.connectorId}@${r.headSha}:${r.importerPath}`)).toEqual(['other@z:o.ts', 'c1@b:c.ts']);
  });
});
