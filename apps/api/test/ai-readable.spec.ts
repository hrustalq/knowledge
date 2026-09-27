import { afterEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { AiReadableService } from '../src/ai-readable/ai-readable.service.js';
import { AiReadableController } from '../src/ai-readable/ai-readable.controller.js';
import { DocumentsService } from '../src/documents/documents.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import matter from 'gray-matter';
import {
  isReadableRevisionStatus,
  READABLE_REVISION_STATUSES,
  readableDocumentsWhere,
} from '../src/ai-readable/ai-readable-scope.js';
import {
  etagFor,
  etagMatches,
  prefersMarkdown,
  renderPageMarkdown,
  wantsFrontmatter,
  type PageMeta,
} from '../src/ai-readable/render.js';

const META: PageMeta = {
  documentId: 'd1',
  revisionId: 'r3',
  revisionNumber: 3,
  project: 'Platform',
  url: 'https://kb.example.com/documents/d1',
  updatedAt: '2026-09-27T10:00:00.000Z',
};

describe('scope predicate', () => {
  it('never admits a draft, and is the one list the listing and the page read share', () => {
    expect(READABLE_REVISION_STATUSES).not.toContain('draft');
    expect(isReadableRevisionStatus('draft')).toBe(false);
    for (const s of ['finalized', 'indexing', 'indexed', 'failed']) expect(isReadableRevisionStatus(s)).toBe(true);
    expect(isReadableRevisionStatus('bogus')).toBe(false);
  });

  it('keys on the workspace, narrows by project and document when given', () => {
    expect(readableDocumentsWhere({ workspaceId: 'w' })).toEqual({ workspaceId: 'w' });
    expect(readableDocumentsWhere({ workspaceId: 'w', projectId: 'p', documentId: 'd' })).toEqual({
      workspaceId: 'w',
      projectId: 'p',
      id: 'd',
    });
  });
});

describe('renderPageMarkdown', () => {
  it('defaults to "# title" + body with no YAML block', () => {
    const out = renderPageMarkdown({ title: 'Billing', body: '\nSome text.\n', frontmatter: { tags: ['x'] } }, META, {
      frontmatter: false,
    });
    expect(out).toBe('# Billing\n\nSome text.\n');
    expect(matter.test(out)).toBe(false);
  });

  it('does not stack a second H1 when the body already opens with one', () => {
    const out = renderPageMarkdown({ title: 'Billing', body: '# Billing service\n\nText\n', frontmatter: null }, META, {
      frontmatter: false,
    });
    expect(out).toBe('# Billing service\n\nText\n');
  });

  it('still adds the title when the body opens with an H2', () => {
    const out = renderPageMarkdown({ title: 'T', body: '## Section\n', frontmatter: null }, META, { frontmatter: false });
    expect(out.startsWith('# T\n\n## Section')).toBe(true);
  });

  it('frontmatter=1 keeps the page keys and namespaces ours under `knowledge`', () => {
    const out = renderPageMarkdown(
      {
        title: 'Billing',
        body: 'Text\n',
        frontmatter: { tags: ['billing'], relations: [{ type: 'DEPENDS_ON', target: 'service:pg' }], url: 'mine' },
      },
      META,
      { frontmatter: true },
    );
    expect(out.startsWith('---\n')).toBe(true);
    const parsed = matter(out);
    expect(parsed.data.tags).toEqual(['billing']);
    expect(parsed.data.relations).toEqual([{ type: 'DEPENDS_ON', target: 'service:pg' }]);
    // The page's own `url:` survives: synthesized keys never overwrite authored ones.
    expect(parsed.data.url).toBe('mine');
    expect(parsed.data.title).toBe('Billing');
    expect(parsed.data.knowledge).toEqual({
      document_id: 'd1',
      revision_id: 'r3',
      revision_number: 3,
      project: 'Platform',
      url: 'https://kb.example.com/documents/d1',
      updated_at: '2026-09-27T10:00:00.000Z',
    });
    expect(parsed.content.trim().startsWith('# Billing')).toBe(true);
  });

  it('keeps an authored title', () => {
    const out = renderPageMarkdown({ title: 'DB title', body: 'x', frontmatter: { title: 'Authored' } }, META, {
      frontmatter: true,
    });
    expect(matter(out).data.title).toBe('Authored');
  });
});

describe('etag', () => {
  const base = { revisionId: 'r3', title: 'Billing', project: 'Platform', frontmatter: false };

  it('is stable for the same inputs and quoted', () => {
    expect(etagFor(base)).toBe(etagFor({ ...base }));
    expect(etagFor(base)).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it('changes with the revision, the title, the project and the representation', () => {
    const e = etagFor(base);
    expect(etagFor({ ...base, revisionId: 'r4' })).not.toBe(e);
    expect(etagFor({ ...base, title: 'Billing v2' })).not.toBe(e);
    expect(etagFor({ ...base, project: 'Core' })).not.toBe(e);
    expect(etagFor({ ...base, frontmatter: true })).not.toBe(e);
  });

  it('matches If-None-Match lists, weak validators and *', () => {
    const e = etagFor(base);
    expect(etagMatches(undefined, e)).toBe(false);
    expect(etagMatches(e, e)).toBe(true);
    expect(etagMatches(`"nope", W/${e}`, e)).toBe(true);
    expect(etagMatches('*', e)).toBe(true);
    expect(etagMatches('"nope"', e)).toBe(false);
  });
});

describe('prefersMarkdown', () => {
  it('is false without an Accept header or for the web client default', () => {
    expect(prefersMarkdown(undefined)).toBe(false);
    expect(prefersMarkdown('application/json, text/plain, */*')).toBe(false);
    expect(prefersMarkdown('*/*')).toBe(false);
  });

  it('is true when markdown is asked for and outranks JSON', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true);
    expect(prefersMarkdown('text/markdown, */*;q=0.1')).toBe(true);
    expect(prefersMarkdown('text/markdown;q=0.9, application/json;q=0.8')).toBe(true);
    expect(prefersMarkdown('text/markdown; charset=utf-8')).toBe(true);
  });

  it('keeps JSON on a tie or when markdown ranks lower or is refused', () => {
    expect(prefersMarkdown('text/markdown, application/json')).toBe(false);
    expect(prefersMarkdown('text/markdown;q=0.5, application/json')).toBe(false);
    expect(prefersMarkdown('text/markdown;q=0')).toBe(false);
    expect(prefersMarkdown('text/*')).toBe(false);
  });
});

describe('wantsFrontmatter', () => {
  it('reads 1/true and nothing else', () => {
    expect(wantsFrontmatter('1')).toBe(true);
    expect(wantsFrontmatter('true')).toBe(true);
    expect(wantsFrontmatter('0')).toBe(false);
    expect(wantsFrontmatter(undefined)).toBe(false);
  });
});


// --- Service + HTTP (mocked PG/S3) -------------------------------------------


const DOC = '44444444-4444-4444-8444-444444444444';
const REV = '55555555-5555-4555-8555-555555555555';
const DRAFT = '66666666-6666-4666-8666-666666666666';

function fakes(opts: { enabled?: boolean } = {}) {
  const revisions: Record<string, { id: string; documentId: string; status: string; revisionNumber: number; finalizedAt: Date; createdAt: Date }> = {
    [REV]: { id: REV, documentId: DOC, status: 'indexed', revisionNumber: 2, finalizedAt: new Date('2026-09-27T10:00:00Z'), createdAt: new Date() },
    [DRAFT]: { id: DRAFT, documentId: DOC, status: 'draft', revisionNumber: 3, finalizedAt: new Date(), createdAt: new Date() },
  };
  const prisma = {
    document: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === DOC
          ? {
              id: DOC,
              workspaceId: 'w',
              projectId: 'p',
              title: 'Billing',
              defaultBranch: 'main',
              branches: [{ name: 'main', headRevisionId: REV }],
              project: { name: 'Platform' },
            }
          : null,
      ),
      count: vi.fn(async () => 1),
    },
    documentRevision: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => revisions[where.id] ?? null) },
  };
  const documents = {
    getContent: vi.fn(async () => ({
      documentId: DOC,
      revisionId: REV,
      contentType: 'text/markdown',
      frontmatter: { tags: ['billing'] },
      markdown: 'Body.\n',
    })),
  };
  const config = {
    get: vi.fn((k: string) =>
      k === 'AI_READABLE_ENABLED' ? (opts.enabled ?? true) : k === 'WEB_BASE_URL' ? 'https://kb.example.com/' : undefined,
    ),
  };
  return { prisma, documents, config };
}

describe('AiReadableService.pageMarkdown', () => {
  it('serves the default-branch head and skips S3 on a matching ETag', async () => {
    const f = fakes();
    const svc = new AiReadableService(f.prisma as never, f.documents as never, f.config as never);
    const first = await svc.pageMarkdown(DOC, { frontmatter: false });
    expect(first.status).toBe(200);
    if (first.status !== 200) return;
    expect(first.body).toBe('# Billing\n\nBody.\n');
    expect(first.llmsIndexUrl).toBe('https://kb.example.com/projects/p/llms.txt');
    expect(f.documents.getContent).toHaveBeenCalledWith(DOC, REV);

    f.documents.getContent.mockClear();
    const again = await svc.pageMarkdown(DOC, { frontmatter: false, ifNoneMatch: first.etag });
    expect(again.status).toBe(304);
    expect(f.documents.getContent).not.toHaveBeenCalled();
  });

  it('refuses a draft revision and a revision of another page', async () => {
    const f = fakes();
    const svc = new AiReadableService(f.prisma as never, f.documents as never, f.config as never);
    await expect(svc.pageMarkdown(DOC, { revisionId: DRAFT, frontmatter: false })).rejects.toThrow(/contentIsDraft|draft/);
    await expect(svc.pageMarkdown(DOC, { revisionId: 'nope', frontmatter: false })).rejects.toThrow();
    expect(f.documents.getContent).not.toHaveBeenCalled();
  });

  it('404s a page outside the readable scope', async () => {
    const f = fakes();
    f.prisma.document.count.mockResolvedValueOnce(0);
    const svc = new AiReadableService(f.prisma as never, f.documents as never, f.config as never);
    await expect(svc.pageMarkdown(DOC, { frontmatter: false })).rejects.toThrow();
  });
});

describe('GET /v1/documents/:id/markdown', () => {
  let app: INestApplication;
  async function boot(enabled = true) {
    const f = fakes({ enabled });
    const mod = await Test.createTestingModule({
      controllers: [AiReadableController],
      providers: [
        AiReadableService,
        { provide: PrismaService, useValue: f.prisma },
        { provide: DocumentsService, useValue: f.documents },
        { provide: ConfigService, useValue: f.config },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
    return f;
  }
  afterEach(async () => app?.close());

  it('answers text/markdown with cache, sniffing and discovery headers', async () => {
    await boot();
    const res = await request(app.getHttpServer()).get(`/v1/documents/${DOC}/markdown`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.headers['vary']).toContain('Accept');
    expect(res.headers['link']).toContain('rel="alternate"');
    expect(res.text).toBe('# Billing\n\nBody.\n');

    const cached = await request(app.getHttpServer())
      .get(`/v1/documents/${DOC}/markdown`)
      .set('If-None-Match', res.headers['etag']);
    expect(cached.status).toBe(304);
    expect(cached.text).toBe('');
  });

  it('frontmatter=1 prepends YAML', async () => {
    await boot();
    const res = await request(app.getHttpServer()).get(`/v1/documents/${DOC}/markdown?frontmatter=1`);
    expect(res.text.startsWith('---\n')).toBe(true);
    expect(matter(res.text).data.knowledge.document_id).toBe(DOC);
  });

  it('404s when AI_READABLE_ENABLED=false', async () => {
    await boot(false);
    const res = await request(app.getHttpServer()).get(`/v1/documents/${DOC}/markdown`);
    expect(res.status).toBe(404);
  });
});
