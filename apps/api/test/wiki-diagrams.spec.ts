import { describe, expect, it } from 'vitest';

/**
 * The repo wiki's diagrams (docs/features/46): the builders, the label
 * escaping, the node budget, the lint, and the inheritance facts the class
 * diagram is drawn from — read off real trees by the real parser.
 */
const {
  architectureFlowchart,
  lintMermaid,
  mermaidBlock,
  mermaidLabel,
  mermaidText,
  moduleClassDiagram,
  sequenceFromJson,
} = await import('../src/connectors/adapters/wiki-diagrams.js');
const { packageOf, resolveModuleEdges, resolveRelativeFile, edgeDigest } = await import(
  '../src/connectors/adapters/import-resolver.js'
);
const { buildRepoMap } = await import('../src/connectors/adapters/repo-map.js');
const { extractSymbols } = await import('../src/connectors/adapters/code-symbols.js');
const { TreeSitterService } = await import('../src/connectors/adapters/tree-sitter.service.js');

const enc = new TextEncoder();
const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, text]) => [path, enc.encode(text)]));

describe('mermaidText / mermaidLabel', () => {
  it('makes a hostile label inert', () => {
    const label = mermaidLabel('click foo "javascript:alert(1)" %%{init}%% <b>x</b> `y` #35;');
    expect(label.startsWith('"') && label.endsWith('"')).toBe(true);
    const inner = label.slice(1, -1);
    for (const bad of ['"', '`', '%', '<', '>', '#', ';', 'click', '{', '}']) expect(inner).not.toContain(bad);
  });

  it('keeps ordinary names, folds whitespace and caps the length', () => {
    expect(mermaidText('  API   server\n(v2) ')).toBe('API server (v2)');
    expect(mermaidText('Сервис биллинга')).toBe('Сервис биллинга');
    expect(mermaidText('x'.repeat(100))).toHaveLength(60);
    expect(mermaidText('<<>>')).toBe('—');
  });
});

describe('architectureFlowchart', () => {
  const modules = [
    { key: 'module:apps/api', name: 'API server' },
    { key: 'module:apps/web', name: 'Web' },
    { key: 'module:packages/contracts', name: '@demo/contracts' },
  ];
  const edges = {
    internal: new Map([
      ['module:apps/api', new Map([['module:packages/contracts', 3]])],
      ['module:apps/web', new Map([['module:packages/contracts', 1]])],
    ]),
    external: new Map([
      ['module:apps/api', new Set(['zod', 'express'])],
      ['module:apps/web', new Set(['zod', 'vue'])],
    ]),
  };

  it('draws a deterministic, lint-clean chart', () => {
    const chart = architectureFlowchart(modules, edges, 40)!;
    expect(chart).toMatchInlineSnapshot(`
      "flowchart LR
        m1["API server"]
        m2["Web"]
        m0["@demo/contracts"]
        x0(["zod"]):::ext
        m1 --> m0
        m1 -.-> x0
        m2 --> m0
        m2 -.-> x0
        classDef ext fill:#f5f5f5,stroke:#999,stroke-dasharray:3 3"
    `);
    expect(lintMermaid(chart)).toBe(true);
  });

  it('honours the node budget, modules first', () => {
    const chart = architectureFlowchart(modules, edges, 2)!;
    expect(chart.match(/^ {2}[mx]\d+[[(]/gm)).toHaveLength(2);
    expect(chart).not.toContain('zod');
  });

  it('draws nothing when there is nothing to connect', () => {
    expect(architectureFlowchart(modules, { internal: new Map(), external: new Map() }, 40)).toBeNull();
  });
});

describe('moduleClassDiagram', () => {
  it('draws exported types, members and both kinds of inheritance', () => {
    const chart = moduleClassDiagram(
      [
        { kind: 'class', name: 'UsersService', signature: '', exported: true, extends: ['Base'], implements: ['Store'], members: ['find', 'save'] },
        { kind: 'interface', name: 'Store', signature: '', exported: true, members: ['get'] },
        { kind: 'class', name: 'Hidden', signature: '', exported: false, members: ['x'] },
        { kind: 'function', name: 'helper', signature: '', exported: true },
      ],
      40,
    )!;
    expect(chart).toMatchInlineSnapshot(`
      "classDiagram
        class C0["UsersService"]
        class C1["Store"]
        class C2["Base"]
        C0 : find
        C0 : save
        <<interface>> C1
        C1 : get
        C2 <|-- C0
        C1 <|.. C0"
    `);
    expect(lintMermaid(chart)).toBe(true);
  });

  it('escapes a symbol named like a Mermaid directive', () => {
    const chart = moduleClassDiagram(
      [{ kind: 'class', name: 'Evil', signature: '', exported: true, extends: ['click foo "javascript:x"'], members: ['click', 'ok'] }],
      40,
    );
    // The bogus supertype is not an identifier, so it never becomes a node; the
    // member named `click` is dropped. What remains still lints.
    expect(chart).not.toMatch(/click|javascript/);
    expect(lintMermaid(chart!)).toBe(true);
  });

  it('returns null for a module with no types worth drawing', () => {
    expect(moduleClassDiagram([{ kind: 'function', name: 'f', signature: '', exported: true }], 40)).toBeNull();
  });
});

describe('sequenceFromJson', () => {
  it('renders the model JSON, dropping messages between unknown participants', () => {
    const chart = sequenceFromJson(
      {
        participants: [{ name: 'Controller' }, { name: 'Service' }, { name: 'DB: postgres' }],
        messages: [
          { from: 'Controller', to: 'Service', label: 'finalize(id)' },
          { from: 'Service', to: 'DB: postgres', label: 'insert revision' },
          { from: 'Service', to: 'Ghost', label: 'never drawn' },
          { from: 'Service', to: 'Controller', label: 'ok', reply: true },
        ],
      },
      8,
    )!;
    expect(chart).toMatchInlineSnapshot(`
      "sequenceDiagram
        participant P0 as Controller
        participant P1 as Service
        participant P2 as DB  postgres
        P0->>P1: finalize(id)
        P1->>P2: insert revision
        P1-->>P0: ok"
    `);
    expect(lintMermaid(chart)).toBe(true);
  });

  it('refuses anything that is not the expected shape', () => {
    expect(sequenceFromJson('sequenceDiagram\n  A->>B: hi', 8)).toBeNull();
    expect(sequenceFromJson({ participants: [{ name: 'only one' }], messages: [] }, 8)).toBeNull();
  });
});

describe('lintMermaid', () => {
  it('rejects anything outside the shapes the builders emit', () => {
    expect(lintMermaid('flowchart LR\n  a["x"]\n  click a "javascript:alert(1)"')).toBe(false);
    expect(lintMermaid('flowchart LR\n  %%{init: {}}%%\n  a["x"]')).toBe(false);
    expect(lintMermaid('graph LR\n  a --> b')).toBe(false);
    expect(lintMermaid('flowchart LR')).toBe(false);
    expect(lintMermaid('sequenceDiagram\n  participant P0 as <img src=x>')).toBe(false);
    expect(mermaidBlock('flowchart LR\n  a["x"]\n  a --> b')).toBe('```mermaid\nflowchart LR\n  a["x"]\n  a --> b\n```');
    expect(mermaidBlock('nonsense')).toBeNull();
  });
});

describe('import resolution', () => {
  const repo = files({
    'apps/api/package.json': JSON.stringify({ name: '@demo/api' }),
    'apps/api/src/main.ts': '',
    'apps/api/src/users/users.ts': '',
    'packages/contracts/package.json': JSON.stringify({ name: '@demo/contracts' }),
    'packages/contracts/src/index.ts': '',
    'packages/contracts/src/core/index.ts': '',
  });
  const map = buildRepoMap(repo, { subdir: '', maxModules: 24 });

  it('resolves manifest names (with subpaths) and relative paths into module edges', () => {
    const edges = resolveModuleEdges(
      map,
      new Map([
        ['apps/api/src/main.ts', ['@demo/contracts/core', './users/users.js', 'zod', '@nestjs/core/router']],
        ['apps/api/src/users/users.ts', ['../../../../packages/contracts/src/index.js']],
      ]),
    );
    expect(edgeDigest(edges)).toEqual([
      'module:apps/api->module:packages/contracts',
      'module:apps/api=>@nestjs/core',
      'module:apps/api=>zod',
    ]);
    expect(edges.internal.get('module:apps/api')?.get('module:packages/contracts')).toBe(2);
  });

  it('finds the file a NodeNext-style or extensionless import names', () => {
    expect(resolveRelativeFile('apps/api/src/main.ts', './users/users.js', repo)).toBe('apps/api/src/users/users.ts');
    expect(resolveRelativeFile('packages/contracts/src/index.ts', './core', repo)).toBe('packages/contracts/src/core/index.ts');
    expect(resolveRelativeFile('apps/api/src/main.ts', './missing', repo)).toBeNull();
  });

  it('reduces a specifier to its package', () => {
    expect(packageOf('@scope/pkg/sub')).toBe('@scope/pkg');
    expect(packageOf('lodash/fp')).toBe('lodash');
    expect(packageOf('github.com/acme/lib/pkg')).toBe('github.com/acme/lib');
  });
});

describe('inheritance in extractSymbols', () => {
  const ts = new TreeSitterService();
  const symbols = (language: string, source: string) =>
    ts.withTree(language as never, source, (tree) => extractSymbols(language as never, tree));

  it('reads TypeScript extends / implements / members', async () => {
    const [cls, iface] = (await symbols(
      'typescript',
      'export class A extends Base<T> implements C, D { x(): void {} y = 1; }\nexport interface I extends J, K { a(): void }',
    ))!;
    expect(cls).toMatchObject({ name: 'A', extends: ['Base'], implements: ['C', 'D'], members: ['x', 'y'] });
    expect(iface).toMatchObject({ name: 'I', extends: ['J', 'K'], members: ['a'] });
  });

  it('reads Python bases, skipping keyword arguments', async () => {
    const [cls] = (await symbols('python', 'class A(B, metaclass=M):\n    def f(self): pass\n'))!;
    expect(cls).toMatchObject({ name: 'A', extends: ['B'], members: ['f'] });
  });

  it('reads Java superclass and interfaces', async () => {
    const [cls] = (await symbols('java', 'public class A extends B implements C, D { void f() {} }'))!;
    expect(cls).toMatchObject({ name: 'A', extends: ['B'], implements: ['C', 'D'], members: ['f'] });
  });

  it('reads Rust trait bounds and same-file impl blocks', async () => {
    const out = (await symbols('rust', 'pub struct S { a: u8 }\nimpl Display for S { fn fmt(&self) {} }\npub trait T: U {}'))!;
    expect(out.find((s) => s.name === 'S')).toMatchObject({ implements: ['Display'], members: ['a'] });
    expect(out.find((s) => s.name === 'T')).toMatchObject({ extends: ['U'] });
  });

  it('reads Go embedding as extends', async () => {
    const [s] = (await symbols('go', 'package x\ntype S struct {\n  Base\n  x int\n}\n'))!;
    expect(s).toMatchObject({ name: 'S', extends: ['Base'], members: ['x'] });
  });
});
