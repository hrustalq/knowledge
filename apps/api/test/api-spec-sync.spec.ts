import { describe, expect, it, vi } from 'vitest';
import { load as parseYaml } from 'js-yaml';

/**
 * Repo sync of API spec files (#78, phase 7): which files are specs, how a
 * spec split across files becomes one document, how the git adapters list and
 * fetch them, and how a changed spec reaches its page — always by merge
 * request, so the breaking-change gate sees it. The archive, Prisma, storage
 * and the documents service are fakes; the bundler, the adapter, the staging
 * service and the sweeper are the real ones.
 */
const ARCHIVE = new Map<string, Uint8Array>();
vi.mock('../src/connectors/adapters/repo-archive.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  downloadRepoArchive: vi.fn(async () => ({ files: ARCHIVE, skipped: { oversize: 0, binary: 0 }, branch: 'main', headSha: null })),
  resolveBranch: vi.fn(async () => 'main'),
}));

const { apiSpecGlobs } = await import('@knowledge/contracts');
const { bundleSpec, repoSpecFiles, suggestSpecFiles } = await import('../src/connectors/adapters/repo-specs.js');
const { parseApiSpec } = await import('../src/api-specs/api-spec.parser.js');
const { MarkdownGitAdapter } = await import('../src/connectors/adapters/markdown-git.adapter.js');
const { ConnectorStagingService } = await import('../src/connectors/connector-staging.service.js');
const { ConnectorConflictSweeper } = await import('../src/connectors/connector-conflict.sweeper.js');
const { composeMarkdown, sha256 } = await import('../src/connectors/connector-markdown.js');

// Warnings and merge request titles are catalogued: load the real catalogs.
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

const enc = (text: string) => new TextEncoder().encode(text);
const repo = (files: Record<string, string>) => new Map(Object.entries(files).map(([p, t]) => [p, enc(t)]));
const LIMITS = { maxBytes: 5_000_000, maxOperations: 2000 };

const ENTRY = `openapi: 3.1.0
info: { title: Billing API, version: '1' }
paths:
  /invoices/{id}:
    get:
      parameters:
        - $ref: './params.yaml#/InvoiceId'
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: { $ref: 'schemas/invoice.yaml' }
  /invoices:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: array
                items: { $ref: 'schemas/invoice.yaml' }
`;
const INVOICE = `type: object
properties:
  id: { type: string }
  lines:
    type: array
    items: { $ref: '#/$defs/Line' }
  parent: { $ref: './invoice.yaml' }
$defs:
  Line:
    type: object
    properties:
      amount: { $ref: '../money.yaml#/Money' }
`;
const PARAMS = `InvoiceId: { name: id, in: path, required: true, schema: { type: string } }\n`;
const MONEY = `Money: { type: integer, description: cents }\n`;

describe('apiSpecGlobs', () => {
  it('reads a comma- or newline-separated string, and nothing from an unset key', () => {
    expect(apiSpecGlobs({ apiSpecs: 'openapi.yaml, specs/**/*.json\n asyncapi.yml ,,' })).toEqual([
      'openapi.yaml',
      'specs/**/*.json',
      'asyncapi.yml',
    ]);
    expect(apiSpecGlobs({})).toEqual([]);
    expect(apiSpecGlobs(null)).toEqual([]);
  });
});

describe('bundleSpec', () => {
  const files = repo({
    'api/openapi.yaml': ENTRY,
    'api/params.yaml': PARAMS,
    'api/schemas/invoice.yaml': INVOICE,
    'api/money.yaml': MONEY,
  });

  it('inlines relative files, shares a repeated target, and ends a cycle across files', () => {
    const { document, changed, issues } = bundleSpec('api/openapi.yaml', files);
    expect(changed).toBe(true);
    expect(issues).toEqual([]);
    const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;

    const get = paths['/invoices/{id}'].get as Record<string, unknown>;
    expect((get.parameters as unknown[])[0]).toEqual({ name: 'id', in: 'path', required: true, schema: { type: 'string' } });

    const firstAt = '/paths/~1invoices~1{id}/get/responses/200/content/application~1json/schema';
    const invoice = (get.responses as Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>>)['200']
      .content['application/json'].schema;
    // The schema recursing into itself points back to where it was placed.
    expect((invoice.properties as Record<string, unknown>).parent).toEqual({ $ref: `#${firstAt}` });
    // A `#/…` inside the referenced file is that file's own, inlined with it.
    const line = ((invoice.properties as Record<string, Record<string, unknown>>).lines.items as Record<string, unknown>);
    expect(line.type).toBe('object');
    expect((line.properties as Record<string, unknown>).amount).toEqual({ type: 'integer', description: 'cents' });

    // The second operation's reference to the same file is not a second copy.
    const list = paths['/invoices'].get as Record<string, unknown>;
    expect(JSON.stringify(list)).toContain(`"$ref":"#${firstAt}"`);
  });

  it('produces a document the parser accepts, with internal refs resolved', async () => {
    const { document } = bundleSpec('api/openapi.yaml', files);
    const parsed = await parseApiSpec(JSON.stringify(document), 'openapi', LIMITS);
    expect(parsed.operations.map((o) => `${o.method} ${o.path}`).sort()).toEqual(['GET /invoices', 'GET /invoices/{id}']);
  });

  it('leaves remote, missing and escaping refs as written, and says which', () => {
    const { document, issues } = bundleSpec(
      'openapi.yaml',
      repo({
        'openapi.yaml': `openapi: 3.1.0
info: { title: T, version: '1' }
components:
  schemas:
    A: { $ref: 'https://example.com/a.yaml' }
    B: { $ref: './gone.yaml' }
    C: { $ref: '../../etc/passwd' }
    D: { $ref: '#/components/schemas/A' }
`,
      }),
    );
    expect(issues.map((i) => i.reason)).toEqual(['remote', 'missing', 'outside']);
    expect((document.components as { schemas: Record<string, unknown> }).schemas).toEqual({
      A: { $ref: 'https://example.com/a.yaml' },
      B: { $ref: './gone.yaml' },
      C: { $ref: '../../etc/passwd' },
      D: { $ref: '#/components/schemas/A' },
    });
  });

  it('changes nothing in a self-contained spec', () => {
    const { changed } = bundleSpec('o.yaml', repo({ 'o.yaml': `openapi: 3.1.0\ninfo: { title: T, version: '1' }\npaths: {}\n` }));
    expect(changed).toBe(false);
  });
});

describe('repoSpecFiles', () => {
  const files = repo({
    'api/openapi.yaml': ENTRY,
    'api/params.yaml': PARAMS,
    'api/schemas/invoice.yaml': INVOICE,
    'api/money.yaml': MONEY,
    'events/asyncapi.json': JSON.stringify({ asyncapi: '3.0.0', info: { title: 'Events', version: '1' }, channels: {} }),
    'docs/readme.md': '# hi',
  });

  it('syncs nothing for a connector that names no globs', () => {
    expect(repoSpecFiles(files, {}, 'en').size).toBe(0);
  });

  it('keeps the files that declare a spec and skips the fragments a broad glob also matches', () => {
    const specs = repoSpecFiles(files, { apiSpecs: 'api/**/*.yaml, *.json' }, 'en');
    expect([...specs.keys()]).toEqual(['api/openapi.yaml', 'events/asyncapi.json']);

    const openapi = specs.get('api/openapi.yaml')!;
    expect(openapi).toMatchObject({ kind: 'openapi', syntax: 'yaml', title: 'Billing API' });
    expect(openapi.warnings[0]).toMatch(/bundled/);
    expect(parseYaml(openapi.text)).toMatchObject({ openapi: '3.1.0' });

    // Self-contained: the bytes as written, still JSON.
    const events = specs.get('events/asyncapi.json')!;
    expect(events).toMatchObject({ kind: 'asyncapi', syntax: 'json', warnings: [] });
    expect(events.text).toBe(Buffer.from(files.get('events/asyncapi.json')!).toString('utf8'));
  });

  it('versions the bundle, so a change to a referenced sibling is a change to the spec', () => {
    const before = repoSpecFiles(files, { apiSpecs: 'openapi.yaml' }, 'en').get('api/openapi.yaml')!.version;
    const edited = new Map(files);
    edited.set('api/money.yaml', enc('Money: { type: number }\n'));
    const after = repoSpecFiles(edited, { apiSpecs: 'openapi.yaml' }, 'en').get('api/openapi.yaml')!.version;
    expect(after).not.toBe(before);
  });
});

describe('suggestSpecFiles', () => {
  it('finds specs by their top-level key, shallowest first, and nothing else', () => {
    const files = repo({
      'services/a/openapi.json': '{\n  "openapi": "3.0.3"\n}',
      'openapi.yaml': 'openapi: 3.1.0\n',
      'events.yml': '# comment\nasyncapi: 2.6.0\n',
      'config.yaml': 'name: x\n',
      'README.md': 'openapi: 3.1.0\n',
    });
    expect(suggestSpecFiles(files)).toEqual(['events.yml', 'openapi.yaml', 'services/a/openapi.json']);
  });
});

describe('MarkdownGitAdapter with apiSpecs', () => {
  const adapter = new MarkdownGitAdapter();
  const ctx = (config: Record<string, unknown>) =>
    ({ config: { repoUrl: 'https://github.com/acme/billing', ...config }, locale: 'en', debug: () => undefined }) as never;

  function seed() {
    ARCHIVE.clear();
    for (const [p, t] of Object.entries({
      'docs/README.md': '# Docs',
      'docs/billing.md': '# Billing',
      'docs/openapi.yaml': ENTRY.replaceAll("'./params.yaml", "'../api/params.yaml").replaceAll("'schemas/", "'../api/schemas/"),
      'api/params.yaml': PARAMS,
      'api/schemas/invoice.yaml': INVOICE,
      'api/money.yaml': MONEY,
    })) {
      ARCHIVE.set(p, enc(t));
    }
  }

  it('hangs a spec in the path tree beside the markdown, and fetches it as a spec', async () => {
    seed();
    const c = ctx({ apiSpecs: 'docs/openapi.yaml' });
    const roots = [];
    for await (const r of adapter.children(c, null)) roots.push(r);
    expect(roots.map((r) => r.externalId)).toEqual(['docs/README.md']);
    const under = [];
    for await (const r of adapter.children(c, roots[0])) under.push(r);
    expect(under.map((r) => [r.externalId, r.title, r.parentExternalId])).toEqual([
      ['docs/billing.md', 'Billing', 'docs/README.md'],
      ['docs/openapi.yaml', 'Billing API', 'docs/README.md'],
    ]);

    const doc = await adapter.fetch(c, under[1]);
    expect(doc.spec).toEqual({ kind: 'openapi', syntax: 'yaml' });
    expect(doc.frontmatter).toBeUndefined();
    // Stored as written: no frontmatter is wrapped around a spec.
    expect(composeMarkdown(doc)).toBe(doc.markdown);
    expect((await parseApiSpec(doc.markdown, 'openapi', LIMITS)).operations).toHaveLength(2);
  });

  it('lists only markdown for a connector that names no specs, and offers what it found', async () => {
    seed();
    const c = ctx({});
    const listed = [];
    for await (const r of adapter.list(c)) listed.push(r.externalId);
    expect(listed).toEqual(['docs/README.md', 'docs/billing.md']);
    expect(await adapter.testConnection(c)).toMatchObject({ ok: true, apiSpecSuggestions: ['docs/openapi.yaml'] });
    expect(await adapter.testConnection(ctx({ apiSpecs: 'docs/openapi.yaml' }))).not.toHaveProperty('apiSpecSuggestions');
  });

  it('names a pushed spec file by its glob in a webhook delivery', () => {
    const body = JSON.stringify({ commits: [{ modified: ['docs/openapi.yaml', 'api/money.yaml', 'docs/billing.md'] }] });
    const c = { ...(ctx({ apiSpecs: 'docs/openapi.yaml' }) as object), webhookSecret: 's' } as never;
    const refs = adapter.verifyWebhook(c, { 'x-gitlab-token': 's' }, body);
    expect(refs?.map((r) => r.externalId)).toEqual(['docs/openapi.yaml', 'docs/billing.md']);
  });
});

describe('ConnectorStagingService, spec items', () => {
  const OLD = 'openapi: 3.1.0\ninfo: { title: A, version: "1" }\npaths: {}\n';
  const NEW = 'openapi: 3.1.0\ninfo: { title: A, version: "2" }\npaths: {}\n';
  const SPEC = { kind: 'openapi', syntax: 'yaml' } as const;

  function harness() {
    const objects = new Map<string, string>([
      ['staged/1', NEW],
      ['rev/head', OLD],
    ]);
    const conflicts: Array<Record<string, unknown>> = [];
    const prisma = {
      connectorLink: {
        findUnique: vi.fn(async () => ({ id: 'l1', documentId: 'd1', contentHash: sha256(OLD), externalUrl: null })),
        update: vi.fn(async () => undefined),
        create: vi.fn(async () => ({ id: 'l2' })),
      },
      document: {
        findUnique: vi.fn(async (args: { select?: unknown }) => (args.select ? { defaultBranch: 'main' } : { id: 'd1' })),
      },
      documentBranch: { findUnique: vi.fn(async () => ({ headRevisionId: 'head' })) },
      documentRevision: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === 'head'
            ? { s3Key: 'rev/head', status: 'indexed' }
            : { s3Key: `rev/${where.id}`, status: 'finalized', contentType: 'application/vnd.oai.openapi+yaml' },
        ),
      },
      connectorConflict: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => conflicts.push(data)),
        findFirst: vi.fn(async () => null),
      },
      connectorRunItem: { update: vi.fn(async () => undefined), findUnique: vi.fn(async () => null) },
      withTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    };
    const storage = {
      getObjectText: vi.fn(async (key: string) => objects.get(key) ?? ''),
      putObjectText: vi.fn(async (key: string, text: string) => objects.set(key, text)),
      connectorItemObjectKey: vi.fn((_w: string, _r: string, _i: string, name: string) => `items/${name}`),
    };
    const documents = {
      createBranch: vi.fn(async () => undefined),
      createRevision: vi.fn(async () => ({ revisionId: 'r2' })),
      finalizeRevision: vi.fn(async () => undefined),
      createDocument: vi.fn(async () => ({ documentId: 'd9', revisionId: 'r9' })),
    };
    const acl = {
      capture: vi.fn(async () => null),
      preview: vi.fn(async () => []),
      applyToPage: vi.fn(async () => ({ changed: false, warnings: [] })),
    };
    const staging = new ConnectorStagingService(prisma as never, documents as never, storage as never, acl as never, { pinMarkdown: async (_ws: string, md: string) => md } as never);
    const row = {
      id: 'c1',
      workspaceId: 'w1',
      projectId: 'p1',
      kind: 'markdown-git',
      category: 'guide',
      conflict: 'manual',
      preserveHierarchy: false,
      parentId: null,
      config: { apiSpecs: 'openapi.yaml' },
    } as never;
    return { staging, row, prisma, documents, conflicts, storage };
  }

  const item = (extra: Record<string, unknown>) =>
    ({
      id: 'i1',
      status: 'staged',
      stagedKey: 'staged/1',
      linkId: 'l1',
      action: 'update',
      externalId: 'openapi.yaml',
      title: 'A',
      parentItemId: null,
      draft: { spec: SPEC },
      ...extra,
    }) as never;

  it('stages a spec under its own extension and marks the draft', async () => {
    const h = harness();
    const adapter = {
      fetch: vi.fn(async (_c: unknown, ref: { externalId: string }) => ({
        ref: { ...ref, version: 'v2' },
        title: 'A',
        markdown: NEW,
        spec: SPEC,
        warnings: [],
      })),
    };
    await h.staging.stage(
      h.row,
      { id: 'run1' } as never,
      adapter as never,
      { debug: () => undefined } as never,
      { id: 'i1', externalId: 'openapi.yaml', title: 'A', externalVersion: 'v2', draft: null } as never,
      null,
    );
    expect(h.storage.putObjectText).toHaveBeenCalledWith('items/staged.yaml', NEW, 'application/vnd.oai.openapi+yaml');
    const data = (h.prisma.connectorRunItem.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ action: 'create', draft: { spec: SPEC } });
  });

  it('creates a new spec as a spec document, inline, under reference', async () => {
    const h = harness();
    await h.staging.apply(h.row, { id: 'run1', mode: 'auto' } as never, item({ linkId: null, action: 'create' }));
    expect(h.documents.createDocument).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'openapi', category: 'reference', content: { mode: 'inline', format: 'yaml', text: NEW } }),
    );
    expect(h.documents.finalizeRevision).not.toHaveBeenCalled();
  });

  it('delivers a changed spec by merge request in every mode, never to the page', async () => {
    for (const mode of ['auto', 'review', 'step']) {
      const h = harness();
      await h.staging.apply(h.row, { id: 'abcdef12-0000-4000-8000-000000000000', mode } as never, item({}));
      expect(h.documents.createBranch).toHaveBeenCalledWith('d1', { name: expect.stringMatching(/^spec\/abcdef12-/) });
      expect(h.documents.createRevision).toHaveBeenCalledWith(
        'd1',
        expect.objectContaining({ branch: expect.stringMatching(/^spec\//), contentType: 'application/vnd.oai.openapi+yaml' }),
      );
      expect(h.conflicts).toEqual([expect.objectContaining({ reason: 'spec-changed', documentId: 'd1' })]);
    }
  });

  it('keeps a two-sided spec conflict a conflict', async () => {
    const h = harness();
    await h.staging.apply(h.row, { id: 'run1', mode: 'review' } as never, item({ action: 'conflict' }));
    expect(h.conflicts).toEqual([expect.objectContaining({ reason: 'conflict' })]);
  });

  it('reads a merged spec change as the connector own page, not a local edit', async () => {
    const h = harness();
    const decide = (h.staging as unknown as { decideAction: (row: unknown, link: unknown) => Promise<string> }).decideAction.bind(
      h.staging,
    );
    h.storage.getObjectText.mockImplementation(async (key: string) => (key === 'rev/head' || key === 'rev/r7' ? NEW : ''));
    h.prisma.connectorConflict.findFirst.mockResolvedValueOnce({ revisionId: 'r7' } as never);
    expect(await decide(h.row, { id: 'l1', documentId: 'd1', contentHash: sha256(OLD) })).toBe('update');
    expect(h.prisma.connectorConflict.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { documentId: 'd1', reason: { in: ['regenerated', 'spec-changed'] } } }),
    );
  });
});

describe('ConnectorConflictSweeper, spec changes', () => {
  function harness(rows: Array<Record<string, unknown>>) {
    const conn = { id: 'c1', name: 'billing', locale: 'en', createdBy: null };
    const prisma = {
      connectorConflict: {
        findMany: vi.fn(async (args: { where: { status: string } }) =>
          args.where.status === 'pending'
            ? rows.filter((r) => r.status === 'pending').map((r) => ({ ...r, connector: conn }))
            : rows.filter((r) => r.status === 'resolved' && r.id !== (args.where as { id?: { not: string } }).id?.not),
        ),
        findFirst: vi.fn(async (args: { where: { createdAt: { gt: Date }; reason: string } }) =>
          rows.find(
            (r) => r.status === 'pending' && r.reason === args.where.reason && (r.createdAt as Date) > args.where.createdAt.gt,
          ) ?? null,
        ),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
          Object.assign(rows.find((r) => r.id === where.id)!, data),
        ),
      },
    };
    const mergeRequests = {
      create: vi.fn(async () => ({ mergeRequest: { mergeRequestId: `mr-${Math.random()}` } })),
      get: vi.fn(async () => ({ mergeRequest: { status: 'open' } })),
      close: vi.fn(async () => undefined),
    };
    const sweeper = new ConnectorConflictSweeper(prisma as never, mergeRequests as never, {} as never);
    return { sweeper, mergeRequests, rows };
  }

  const base = { documentId: 'd1', branch: 'spec/x', revisionId: 'r1', externalUrl: 'https://github.com/acme/billing', title: 'Billing API' };

  it('titles it as a spec change, and opens only the newest of a burst', async () => {
    const h = harness([
      { id: 'old', status: 'resolved', reason: 'spec-changed', mergeRequestId: 'mr-old', createdAt: new Date(1), ...base },
      { id: 'k1', status: 'pending', reason: 'spec-changed', createdAt: new Date(2), ...base },
      { id: 'k2', status: 'pending', reason: 'spec-changed', createdAt: new Date(3), ...base },
    ]);
    await h.sweeper.sweep();
    expect(h.rows.find((r) => r.id === 'k1')!.status).toBe('superseded');
    expect(h.mergeRequests.create).toHaveBeenCalledTimes(1);
    const [, dto] = h.mergeRequests.create.mock.calls[0] as unknown as [string, { title: string; description: string }];
    expect(dto.title).toBe('billing: API spec "Billing API" changed');
    expect(dto.description).toContain('breaking changes first');
    expect(h.mergeRequests.close).toHaveBeenCalledWith('mr-old', undefined);
  });
});
