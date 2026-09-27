import { afterEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { orderPages, renderFullPage, renderHub, renderLlmsIndex, type IndexPage } from '../src/ai-readable/llms.js';
import { AiReadableService } from '../src/ai-readable/ai-readable.service.js';
import { LlmsTxtController } from '../src/ai-readable/llms-txt.controller.js';
import { DocumentsService } from '../src/documents/documents.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { StorageService } from '../src/storage/storage.service.js';
import { AccessService } from '../src/auth/access.service.js';
import { AuditService } from '../src/auth/audit.service.js';
import { ACCESS_META } from '../src/auth/access.decorator.js';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';

/**
 * llms.txt / llms-full.txt (issue #68, phase 2). What is pinned:
 * - tree order, the llmstxt.org shape, drafts and draft-only pages absent;
 * - llms-full streams, caps with an in-band marker (200, never 500), and a
 *   failed S3 read becomes a marker instead of killing the stream;
 * - ETag/304 costs no S3 read; the bulk export writes one audit row;
 * - every scoped route carries @Access, the hub filters by requireRole.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const WS2 = '22222222-2222-4222-8222-222222222222';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const page = (o: Partial<IndexPage> & { id: string }): IndexPage => ({
  title: o.id.toUpperCase(),
  category: 'guide',
  parentId: null,
  position: 0,
  projectId: P1,
  headRevisionId: `rev-${o.id}`,
  s3Key: `k/${o.id}`,
  ...o,
});

describe('orderPages', () => {
  it('walks the tree depth-first, siblings by position then title', () => {
    const out = orderPages([
      page({ id: 'b', position: 1 }),
      page({ id: 'a', position: 0 }),
      page({ id: 'a2', parentId: 'a', position: 1 }),
      page({ id: 'a1', parentId: 'a', position: 0 }),
      page({ id: 'a1x', parentId: 'a1' }),
    ]);
    expect(out.map((p) => [p.id, p.depth])).toEqual([
      ['a', 0],
      ['a1', 1],
      ['a1x', 2],
      ['a2', 1],
      ['b', 0],
    ]);
  });

  it('surfaces a page whose parent is not exported as a root, and survives a cycle', () => {
    const out = orderPages([
      page({ id: 'orphan', parentId: 'draft-only-parent' }),
      page({ id: 'x', parentId: 'y' }),
      page({ id: 'y', parentId: 'x' }),
    ]);
    expect(out.map((p) => p.id).sort()).toEqual(['orphan', 'x', 'y']);
    expect(out.find((p) => p.id === 'orphan')?.depth).toBe(0);
  });
});

describe('renderLlmsIndex', () => {
  it('is llmstxt.org-shaped: H1, blockquote, ## per project, indented links', () => {
    const txt = renderLlmsIndex({
      title: 'Acme',
      blurb: 'Pages in workspace Acme as markdown.',
      fullUrl: 'https://api/v1/workspaces/w/llms-full.txt',
      sections: [
        {
          heading: 'Platform',
          pages: [
            { id: 'a', title: 'Billing', category: 'guide', depth: 0, url: 'https://kb/documents/a.md' },
            { id: 'b', title: 'Refunds [v2]', category: 'process', depth: 1, url: 'https://kb/documents/b.md' },
          ],
        },
        { heading: 'Empty', pages: [] },
      ],
    });
    expect(txt).toBe(
      [
        '# Acme',
        '',
        '> Pages in workspace Acme as markdown.',
        '',
        'Full text: https://api/v1/workspaces/w/llms-full.txt',
        '',
        '## Platform',
        '',
        '- [Billing](https://kb/documents/a.md): guide',
        '  - [Refunds \\[v2\\]](https://kb/documents/b.md): process',
        '',
      ].join('\n'),
    );
  });
});

describe('renderFullPage', () => {
  it('puts a Source line under the heading', () => {
    expect(renderFullPage({ title: 'T', body: 'Body\n', url: 'https://kb/documents/a' })).toBe(
      '# T\n\nSource: https://kb/documents/a\n\nBody\n',
    );
    expect(renderFullPage({ title: 'T', body: '# Own H1\n\nBody\n', url: 'u' })).toBe(
      '# Own H1\n\nSource: u\n\nBody\n',
    );
  });
});

describe('renderHub', () => {
  it('lists each workspace with its index, full text and projects', () => {
    const txt = renderHub('https://api', [
      { workspaceId: 'w', name: 'Acme', projects: [{ projectId: 'p', name: 'Platform' }] },
    ]);
    expect(txt).toContain('# Knowledge');
    expect(txt).toContain('## Acme');
    expect(txt).toContain('- [Acme: all projects](https://api/v1/workspaces/w/llms.txt)');
    expect(txt).toContain('- [Acme: full text](https://api/v1/workspaces/w/llms-full.txt)');
    expect(txt).toContain('- [Platform](https://api/v1/projects/p/llms.txt)');
  });
});

// --- service + HTTP ----------------------------------------------------------

type Doc = {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  category: string;
  parentId: string | null;
  position: number;
  defaultBranch: string;
  branches: { name: string; headRevisionId: string | null }[];
};

function world(env: Record<string, unknown> = {}) {
  const docs: Doc[] = [
    { id: 'd1', workspaceId: WS, projectId: P1, title: 'Billing', category: 'guide', parentId: null, position: 0, defaultBranch: 'main', branches: [{ name: 'main', headRevisionId: 'r1' }, { name: 'feat', headRevisionId: 'rX' }] },
    { id: 'd2', workspaceId: WS, projectId: P1, title: 'Refunds', category: 'process', parentId: 'd1', position: 0, defaultBranch: 'main', branches: [{ name: 'main', headRevisionId: 'r2' }] },
    { id: 'd3', workspaceId: WS, projectId: P2, title: 'Draft only', category: 'other', parentId: null, position: 0, defaultBranch: 'main', branches: [{ name: 'main', headRevisionId: 'r3' }] },
    { id: 'd4', workspaceId: WS, projectId: P2, title: 'Runbook', category: 'guide', parentId: null, position: 1, defaultBranch: 'main', branches: [{ name: 'main', headRevisionId: 'r4' }] },
  ];
  const revs: Record<string, { id: string; status: string; s3Key: string }> = {
    r1: { id: 'r1', status: 'indexed', s3Key: 's/r1' },
    r2: { id: 'r2', status: 'finalized', s3Key: 's/r2' },
    r3: { id: 'r3', status: 'draft', s3Key: 's/r3' },
    r4: { id: 'r4', status: 'failed', s3Key: 's/r4' },
    rX: { id: 'rX', status: 'indexed', s3Key: 's/rX' },
  };
  const bodies: Record<string, string> = {
    's/r1': '---\ntags: [billing]\n---\nBilling body.\n',
    's/r2': 'Refunds body.\n',
    's/r3': 'SECRET DRAFT\n',
    's/r4': 'Runbook body.\n',
    's/rX': 'FEATURE BRANCH\n',
  };
  const prisma = {
    document: {
      findMany: vi.fn(async ({ where }: { where: { workspaceId: string; projectId?: string } }) =>
        docs.filter((d) => d.workspaceId === where.workspaceId && (!where.projectId || d.projectId === where.projectId)),
      ),
    },
    documentRevision: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => revs[id]).filter(Boolean),
      ),
    },
    project: {
      findMany: vi.fn(async ({ where }: { where: { workspaceId?: string; id?: string } }) =>
        [
          { id: P1, workspaceId: WS, name: 'Platform' },
          { id: P2, workspaceId: WS, name: 'Ops' },
        ].filter((p) => (!where.workspaceId || p.workspaceId === where.workspaceId) && (!where.id || p.id === where.id)),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === P1 ? { id: P1, workspaceId: WS, name: 'Platform' } : where.id === P2 ? { id: P2, workspaceId: WS, name: 'Ops' } : null,
      ),
    },
    workspace: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === WS ? { id: WS, name: 'Acme' } : null)),
      findMany: vi.fn(async () => [
        { id: WS, name: 'Acme' },
        { id: WS2, name: 'Other' },
      ]),
    },
    workspaceMember: { findMany: vi.fn(async () => [{ workspaceId: WS, role: 'viewer' }]) },
  };
  const storage = {
    getObjectText: vi.fn(async (key: string) => {
      if (key === 'boom') throw new Error('s3 down');
      return bodies[key];
    }),
  };
  const values: Record<string, unknown> = {
    AI_READABLE_ENABLED: true,
    WEB_BASE_URL: 'https://kb',
    API_PUBLIC_URL: 'https://api',
    LLMS_FULL_MAX_DOCS: 2000,
    LLMS_FULL_MAX_BYTES: 20_000_000,
    AI_READABLE_FETCH_CONCURRENCY: 2,
    ...env,
  };
  const config = { get: vi.fn((k: string) => values[k]) };
  const audit = { record: vi.fn(async () => undefined) };
  const access = {
    requireRole: vi.fn(async (_p: unknown, ws: string) => {
      if (ws !== WS) throw new Error('forbidden');
    }),
  };
  return { prisma, storage, config, audit, access, bodies };
}

describe('llms.txt routes', () => {
  let app: INestApplication;
  async function boot(env: Record<string, unknown> = {}) {
    const w = world(env);
    const mod = await Test.createTestingModule({
      controllers: [LlmsTxtController],
      providers: [
        AiReadableService,
        { provide: PrismaService, useValue: w.prisma },
        { provide: DocumentsService, useValue: {} },
        { provide: StorageService, useValue: w.storage },
        { provide: ConfigService, useValue: w.config },
        { provide: AuditService, useValue: w.audit },
        { provide: AccessService, useValue: w.access },
      ],
    }).compile();
    app = mod.createNestApplication();
    // What AuthGuard would attach: the principal the hub filters for.
    app.use((req: { principal?: unknown }, _res: unknown, next: () => void) => {
      req.principal = { ...DEV_PRINCIPAL, mode: 'api-key', isAdmin: false, userId: 'u1' };
      next();
    });
    await app.init();
    return w;
  }
  afterEach(async () => app?.close());

  it('workspace llms.txt lists readable default-branch heads in tree order, per project', async () => {
    const w = await boot();
    const res = await request(app.getHttpServer()).get(`/v1/workspaces/${WS}/llms.txt`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.text.startsWith('# Acme\n')).toBe(true);
    expect(res.text).toContain('## Platform\n\n- [Billing](https://kb/documents/d1.md): guide\n  - [Refunds](https://kb/documents/d2.md): process');
    expect(res.text).toContain('## Ops\n\n- [Runbook](https://kb/documents/d4.md): guide');
    expect(res.text).not.toContain('Draft only');
    expect(res.text).toContain('https://api/v1/workspaces/' + WS + '/llms-full.txt');
    // An index never reads page bodies and is not audited.
    expect(w.storage.getObjectText).not.toHaveBeenCalled();
    expect(w.audit.record).not.toHaveBeenCalled();

    const again = await request(app.getHttpServer()).get(`/v1/workspaces/${WS}/llms.txt`).set('If-None-Match', res.headers.etag);
    expect(again.status).toBe(304);
  });

  it('project llms.txt lists only that project', async () => {
    await boot();
    const res = await request(app.getHttpServer()).get(`/v1/projects/${P2}/llms.txt`);
    expect(res.status).toBe(200);
    expect(res.text.startsWith('# Ops\n')).toBe(true);
    expect(res.text).toContain('Runbook');
    expect(res.text).not.toContain('Billing');
  });

  it('llms-full.txt streams every readable head once, never drafts or other branches, and audits once', async () => {
    const w = await boot();
    const res = await request(app.getHttpServer()).get(`/v1/workspaces/${WS}/llms-full.txt`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    const t = res.text;
    expect(t.indexOf('Billing body.')).toBeGreaterThan(-1);
    expect(t.indexOf('Billing body.')).toBeLessThan(t.indexOf('Refunds body.'));
    expect(t.indexOf('Refunds body.')).toBeLessThan(t.indexOf('Runbook body.'));
    expect(t).toContain('Source: https://kb/documents/d1');
    expect(t).not.toContain('tags:');
    expect(t).not.toContain('SECRET DRAFT');
    expect(t).not.toContain('FEATURE BRANCH');
    expect(t.match(/Billing body\./g)).toHaveLength(1);
    expect(w.audit.record).toHaveBeenCalledTimes(1);
    expect(w.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, action: 'ai-readable.llms-full', rowCount: 3, ok: true }),
    );
  });

  it('caps by pages with an in-band marker, 200 not 500', async () => {
    await boot({ LLMS_FULL_MAX_DOCS: 2 });
    const res = await request(app.getHttpServer()).get(`/v1/workspaces/${WS}/llms-full.txt`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Refunds body.');
    expect(res.text).not.toContain('Runbook body.');
    expect(res.text).toMatch(/<!-- truncated: 1 more page/);
  });

  it('caps by bytes', async () => {
    await boot({ LLMS_FULL_MAX_BYTES: 120 });
    const res = await request(app.getHttpServer()).get(`/v1/workspaces/${WS}/llms-full.txt`);
    expect(res.status).toBe(200);
    // Two ~58-byte pages fit under 120; the third would not.
    expect(res.text).toContain('Refunds body.');
    expect(res.text).not.toContain('Runbook body.');
    expect(res.text).toMatch(/<!-- truncated: 1 more page; see https:\/\/api\/v1\/projects\//);
  });

  it('turns a failed page read into a marker and keeps streaming', async () => {
    const w = await boot();
    w.storage.getObjectText.mockImplementation(async (key: string) => {
      if (key === 's/r2') throw new Error('s3 down');
      return w.bodies[key];
    });
    const res = await request(app.getHttpServer()).get(`/v1/workspaces/${WS}/llms-full.txt`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<!-- unavailable: d2 -->');
    expect(res.text).toContain('Runbook body.');
  });

  it('llms-full.txt 304s without reading S3', async () => {
    const w = await boot();
    const first = await request(app.getHttpServer()).get(`/v1/projects/${P1}/llms-full.txt`);
    w.storage.getObjectText.mockClear();
    w.audit.record.mockClear();
    const again = await request(app.getHttpServer()).get(`/v1/projects/${P1}/llms-full.txt`).set('If-None-Match', first.headers.etag);
    expect(again.status).toBe(304);
    expect(w.storage.getObjectText).not.toHaveBeenCalled();
    expect(w.audit.record).not.toHaveBeenCalled();
  });

  it('the hub lists only workspaces requireRole lets through', async () => {
    await boot();
    const res = await request(app.getHttpServer()).get('/v1/llms.txt');
    expect(res.status).toBe(200);
    expect(res.text).toContain('## Acme');
    expect(res.text).not.toContain('Other');
    expect(res.text).toContain(`https://api/v1/projects/${P1}/llms.txt`);
  });

  it('AI_READABLE_ENABLED=false 404s every route', async () => {
    await boot({ AI_READABLE_ENABLED: false });
    for (const path of ['/v1/llms.txt', `/v1/workspaces/${WS}/llms.txt`, `/v1/workspaces/${WS}/llms-full.txt`, `/v1/projects/${P1}/llms.txt`, `/v1/projects/${P1}/llms-full.txt`]) {
      expect((await request(app.getHttpServer()).get(path)).status).toBe(404);
    }
  });
});

describe('guards', () => {
  it('every scoped route declares @Access viewer; only the hub checks by hand', () => {
    const proto = LlmsTxtController.prototype as unknown as Record<string, unknown>;
    const expected: Record<string, unknown> = {
      workspaceIndex: { role: 'viewer', source: 'workspace', operator: false },
      workspaceFull: { role: 'viewer', source: 'workspace', operator: false },
      projectIndex: { role: 'viewer', source: 'project', operator: false },
      projectFull: { role: 'viewer', source: 'project', operator: false },
      hub: undefined,
    };
    // Route handlers are the methods Nest put a path on.
    const handlers = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor' && Reflect.getMetadata('path', proto[n] as object) !== undefined,
    );
    expect(handlers.sort()).toEqual(Object.keys(expected).sort());
    for (const [name, spec] of Object.entries(expected)) {
      expect(Reflect.getMetadata(ACCESS_META, proto[name] as object)).toEqual(spec);
    }
  });
});
