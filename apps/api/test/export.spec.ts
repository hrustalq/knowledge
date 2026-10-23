import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { strFromU8, unzipSync } from 'fflate';
import type { ExportJob } from '@prisma/client';
import type { ExportManifest } from '@knowledge/contracts';
import { ExportService, exportFilename } from '../src/export/export.service.js';
import { ExportScopeService } from '../src/export/export-scope.service.js';
import { ExportBuildService } from '../src/export/export-build.service.js';
import { ExportSweeper } from '../src/export/export.sweeper.js';
import {
  archiveRoot,
  attachmentArchivePath,
  buildManifest,
  pdfAssetName,
  safeFilename,
  zipArchive,
  type PackagedPage,
} from '../src/export/export-package.js';
import type { Principal } from '../src/auth/principal.js';

/**
 * Exports (docs/features/45, issue #77 phase 2c). What is pinned:
 * - asking: PDF is refused up front without Gotenberg, a scope over
 *   EXPORT_MAX_PAGES is refused before anything is queued, an archived page
 *   has nothing to export, and a queue that refuses the job leaves a failed
 *   row rather than a `queued` one forever;
 * - seeing: only the requester or an admin; a running export is 409, an
 *   expired one 410, and the download is a short-lived attachment URL;
 * - scope: a subtree is `documents.path`, delimited, in the caller's
 *   workspace only; the branch rule falls back per page and skips drafts;
 * - the archive: one top folder, manifest.json in reading order, markdown
 *   with frontmatter, attachments under their ids, names that cannot climb;
 * - the build: ZIP end to end, PDF through the renderer and Gotenberg with
 *   only images uploaded, a renderer failure named as such, and the event
 *   addressed to the requester alone;
 * - the sweeper: expired files are purged and the row kept, lost jobs fail.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '99999999-9999-4999-8999-999999999999';
const DOC = '22222222-2222-4222-8222-222222222222';
const PROJ = '33333333-3333-4333-8333-333333333333';
const ME = '44444444-4444-4444-8444-444444444444';
const SOMEONE = '55555555-5555-4555-8555-555555555555';

const principal = (userId = ME): Principal =>
  ({ userId, email: 'x@example.com', displayName: 'X', avatarUrl: null, mode: 'session', isAdmin: false, locale: 'en' }) as Principal;

function configOf(over: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    EXPORT_MAX_PAGES: 3,
    EXPORT_MAX_BYTES: 1_000_000,
    EXPORT_TTL_HOURS: 72,
    EXPORT_TIMEOUT_MS: 60_000,
    GOTENBERG_URL: '',
    ...over,
  };
  return { get: (k: string) => values[k] };
}

function jobRow(over: Partial<ExportJob> = {}): ExportJob {
  return {
    id: 'job-1',
    workspaceId: WS,
    scope: 'subtree',
    documentId: DOC,
    projectId: null,
    branch: null,
    format: 'zip',
    title: 'Install Guide',
    status: 'queued',
    stage: null,
    pageCount: null,
    s3Key: null,
    sizeBytes: null,
    error: null,
    locale: 'en',
    requestedBy: ME,
    shareLinkId: null,
    createdAt: new Date('2026-10-13T10:00:00Z'),
    startedAt: null,
    completedAt: null,
    expiresAt: null,
    ...over,
  };
}

/** Admin when `admins` names the caller; anyone else is a plain member. */
const accessOf = (admins: string[] = []) => ({
  requireRole: vi.fn(async (p: Principal, _ws: string, role: string) => {
    if (role === 'admin' && !admins.includes(p.userId)) throw new Error('forbidden');
  }),
});

// ------------------------------------------------------------------ asking

describe('ExportService.create*', () => {
  function service(opts: { scopeCount?: number; config?: Record<string, unknown>; enqueue?: () => Promise<void>; archived?: boolean } = {}) {
    const created: ExportJob[] = [];
    const prisma = {
      document: {
        findUnique: vi.fn(async () => ({ workspaceId: WS, title: 'Install Guide', archivedAt: opts.archived ? new Date() : null })),
      },
      project: { findUnique: vi.fn(async () => ({ workspaceId: WS, name: 'Handbook' })) },
      exportJob: {
        create: vi.fn(async ({ data }: { data: Partial<ExportJob> }) => {
          const row = jobRow({ ...data, id: 'job-new' });
          created.push(row);
          return row;
        }),
        update: vi.fn(async ({ data }: { data: Partial<ExportJob> }) => ({ ...created[0], ...data })),
      },
    };
    const scope = { documents: vi.fn(async () => Array.from({ length: opts.scopeCount ?? 2 }, (_, i) => ({ id: `d${i}` }))) };
    const producer = { enqueue: vi.fn(opts.enqueue ?? (async () => undefined)) };
    const svc = new ExportService(
      prisma as never,
      accessOf() as never,
      {} as never,
      scope as never,
      producer as never,
      configOf(opts.config) as never,
    );
    return { svc, prisma, scope, producer, created };
  }

  it('refuses PDF when the deployment has no Gotenberg, before anything is written', async () => {
    const { svc, prisma } = service();
    await expect(svc.createForDocument(DOC, { format: 'pdf' }, principal())).rejects.toMatchObject({
      status: 409,
      response: { reason: 'export.formatUnavailable' },
    });
    expect(prisma.exportJob.create).not.toHaveBeenCalled();
    // Word needs nothing beyond the worker, so it is always on.
    expect(svc.capabilities().formats).toEqual({ zip: true, html: true, pdf: false, docx: true });
  });

  it('offers PDF once GOTENBERG_URL is set', async () => {
    const { svc } = service({ config: { GOTENBERG_URL: 'http://gotenberg:3000' } });
    expect(svc.capabilities().formats.pdf).toBe(true);
    await expect(svc.createForDocument(DOC, { format: 'pdf' }, principal())).resolves.toMatchObject({ format: 'pdf' });
  });

  it('refuses a scope over EXPORT_MAX_PAGES with the count, before it is queued', async () => {
    const { svc, producer } = service({ scopeCount: 4 });
    await expect(svc.createForProject(PROJ, { format: 'zip' }, principal())).rejects.toMatchObject({
      status: 400,
      response: { reason: 'export.tooManyPages', count: 4, max: 3 },
    });
    expect(producer.enqueue).not.toHaveBeenCalled();
  });

  it('has nothing to export from an archived page', async () => {
    const { svc, scope } = service({ archived: true });
    await expect(svc.createForDocument(DOC, { format: 'zip' }, principal())).rejects.toMatchObject({
      response: { reason: 'export.nothingToExport' },
    });
    expect(scope.documents).not.toHaveBeenCalled();
  });

  it('records the request — scope, title, branch, requester — and queues it', async () => {
    const { svc, created, producer } = service();
    const job = await svc.createForDocument(DOC, { format: 'html', includeSubtree: true, branch: ' next ' }, principal());
    expect(created[0]).toMatchObject({ scope: 'subtree', documentId: DOC, projectId: null, format: 'html', branch: 'next', title: 'Install Guide', requestedBy: ME });
    expect(producer.enqueue).toHaveBeenCalledWith('job-new');
    expect(job).toMatchObject({ id: 'job-new', status: 'queued' });
  });

  it('a share link’s job (#161): the link’s scope, the link as its owner, the creator as attribution only', async () => {
    const { svc, created, scope } = service();
    const share = { id: 'share-1', workspaceId: WS, documentId: DOC, includeSubtree: true, createdBy: SOMEONE };
    const row = await svc.createForShareLink(share, 'zip');
    expect(created[0]).toMatchObject({ scope: 'subtree', documentId: DOC, projectId: null, branch: null, requestedBy: SOMEONE, shareLinkId: 'share-1' });
    // Counted as the link's reader, never as its creator.
    expect(scope.documents).toHaveBeenCalledWith(expect.objectContaining({ requester: { shareLinkId: 'share-1' }, scope: 'subtree' }));
    expect(row.shareLinkId).toBe('share-1');
    await svc.createForShareLink({ ...share, includeSubtree: false }, 'zip');
    expect(created[1]).toMatchObject({ scope: 'page' });
  });

  it('leaves a failed row, not a queued one, when the queue refuses the job', async () => {
    const { svc } = service({ enqueue: async () => Promise.reject(new Error('redis down')) });
    const job = await svc.createForProject(PROJ, { format: 'zip' }, principal());
    expect(job.status).toBe('failed');
    expect(job.error?.code).toBe('failed');
  });
});

// ------------------------------------------------------------------ seeing

describe('ExportService: who sees an export', () => {
  function service(row: ExportJob, admins: string[] = []) {
    const prisma = {
      exportJob: {
        findUnique: vi.fn(async () => row),
        findMany: vi.fn(async () => [row]),
      },
    };
    const storage = { presignGet: vi.fn(async () => 'https://minio/signed') };
    const svc = new ExportService(prisma as never, accessOf(admins) as never, storage as never, {} as never, {} as never, configOf() as never);
    return { svc, prisma, storage };
  }

  it('shows an export to its requester and to an admin, and to nobody else', async () => {
    const row = jobRow();
    await expect(service(row).svc.get(row.id, principal(ME))).resolves.toMatchObject({ id: row.id });
    await expect(service(row, [SOMEONE]).svc.get(row.id, principal(SOMEONE))).resolves.toMatchObject({ id: row.id });
    await expect(service(row).svc.get(row.id, principal(SOMEONE))).rejects.toMatchObject({ status: 403 });
  });

  it('lists a member’s own exports and an admin’s whole workspace', async () => {
    const member = service(jobRow());
    await member.svc.list(WS, principal(ME));
    // A share link reader's job is not its creator's history (#161).
    expect(member.prisma.exportJob.findMany.mock.calls[0][0]).toMatchObject({ where: { workspaceId: WS, requestedBy: ME, shareLinkId: null } });
    const admin = service(jobRow(), [ME]);
    await admin.svc.list(WS, principal(ME));
    expect(admin.prisma.exportJob.findMany.mock.calls[0][0].where).toEqual({ workspaceId: WS });
  });

  it('a share link’s job is that link’s alone: another link, a member’s job and its creator all miss (#161)', async () => {
    const row = jobRow({ shareLinkId: 'share-1', requestedBy: ME, status: 'completed', s3Key: 'k', expiresAt: new Date(Date.now() + 3_600_000) });
    const { svc } = service(row);
    const link = { id: 'share-1', includeSubtree: true };
    await expect(svc.shareLinkJob(row.id, link)).resolves.toMatchObject({ id: row.id });
    await expect(svc.shareLinkDownload(row.id, link)).resolves.toMatchObject({ url: 'https://minio/signed' });
    await expect(svc.shareLinkJob(row.id, { ...link, id: 'share-2' })).rejects.toMatchObject({ status: 404 });
    await expect(svc.shareLinkDownload(row.id, { ...link, id: 'share-2' })).rejects.toMatchObject({ status: 404 });
    await expect(service(jobRow()).svc.shareLinkJob('job-1', link)).rejects.toMatchObject({ status: 404 });
    // The link narrowed to its page since: the subtree file is no longer handed out.
    await expect(svc.shareLinkDownload(row.id, { ...link, includeSubtree: false })).rejects.toMatchObject({ status: 404 });
    await expect(service(jobRow({ ...row, scope: 'page' })).svc.shareLinkJob(row.id, { ...link, includeSubtree: false })).resolves.toBeDefined();
    // The creator is attribution, not the owner; an admin still sees it.
    await expect(svc.get(row.id, principal(ME))).rejects.toMatchObject({ status: 403 });
    await expect(service(row, [SOMEONE]).svc.get(row.id, principal(SOMEONE))).resolves.toMatchObject({ id: row.id });
  });

  it('answers 409 while the file is being made and 410 once it is gone', async () => {
    await expect(service(jobRow({ status: 'running' })).svc.download('job-1', principal())).rejects.toMatchObject({
      status: 409,
      response: { reason: 'export.notReady' },
    });
    await expect(service(jobRow({ status: 'expired' })).svc.download('job-1', principal())).rejects.toMatchObject({
      status: 410,
      response: { reason: 'export.expired' },
    });
    const pastDue = jobRow({ status: 'completed', s3Key: 'k', expiresAt: new Date(Date.now() - 1000) });
    await expect(service(pastDue).svc.download('job-1', principal())).rejects.toMatchObject({ status: 410 });
  });

  it('hands back a short-lived URL that downloads under a readable name', async () => {
    const row = jobRow({ status: 'completed', s3Key: 'workspaces/w/exports/job-1/install-guide.zip', expiresAt: new Date(Date.now() + 3_600_000) });
    const { svc, storage } = service(row);
    await expect(svc.download(row.id, principal())).resolves.toEqual({ url: 'https://minio/signed', filename: 'install-guide.zip' });
    expect(storage.presignGet).toHaveBeenCalledWith(row.s3Key, expect.objectContaining({ disposition: 'attachment', contentType: 'application/zip' }));
  });

  it('names files from the title, marks an HTML bundle and never yields an empty name', () => {
    expect(exportFilename('Install Guide', 'pdf')).toBe('install-guide.pdf');
    expect(exportFilename('Install Guide', 'html')).toBe('install-guide-html.zip');
    expect(exportFilename('Install Guide', 'docx')).toBe('install-guide.docx');
    expect(exportFilename('Руководство', 'zip')).toBe('руководство.zip');
    expect(exportFilename('???', 'zip')).toBe('export.zip');
  });
});

// ------------------------------------------------------------------ scope

describe('ExportScopeService', () => {
  const REQUESTER = { userId: 'u-1', locale: 'en' as const };
  /** A requester who sees all but page `hidden` (#76): the predicate itself is pinned in permissions.spec.ts. */
  function scopeService(prisma: unknown) {
    const access = { principalFor: vi.fn(async (userId: string) => ({ userId, mode: 'api-key', isAdmin: false })) };
    const permissions = {
      scopeFor: vi.fn(async () => ({
        workspaceId: WS,
        bypass: false,
        guest: false,
        denied: new Set(['hidden']),
        granted: new Set(),
      })),
    };
    return { scope: new ExportScopeService(prisma as never, access as never, permissions as never), access, permissions };
  }

  it('reads a subtree by its delimited path, live pages only, in the caller’s workspace', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = {
      document: {
        findFirst: vi.fn(async () => ({ id: DOC, workspaceId: WS, path: `/${DOC}/`, archivedAt: null, parentId: null, title: 'Root', position: 0, category: 'guide' })),
        findMany,
      },
    };
    await scopeService(prisma).scope.documents({ workspaceId: WS, scope: 'subtree', documentId: DOC, projectId: null, requester: REQUESTER });
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { workspaceId: WS, archivedAt: null, path: { startsWith: `/${DOC}/` } } });
  });

  it('holds only what the requester may open, resolving them afresh when the worker runs the job (#76)', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { document: { findFirst: vi.fn(), findMany } };
    const { scope, access } = scopeService(prisma);
    await scope.documents({ workspaceId: WS, scope: 'project', documentId: null, projectId: 'p-1', requester: REQUESTER });
    expect(access.principalFor).toHaveBeenCalledWith('u-1', 'en');
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { projectId: 'p-1', AND: [{ AND: [{ NOT: { restrictedBy: { hasSome: ['hidden'] } } }] }] },
    });
  });

  it('holds what a share link shows, not what its creator may open (#161)', async () => {
    const findFirst = vi.fn(async () => ({ id: DOC, workspaceId: WS, path: `/${DOC}/`, archivedAt: null, parentId: null, title: 'Root', position: 0, category: 'guide' }));
    const findMany = vi.fn(async () => []);
    const { scope, access, permissions } = scopeService({ document: { findFirst, findMany } });
    const reader = { shareLinkId: 'share-1' };
    await scope.documents({ workspaceId: WS, scope: 'subtree', documentId: DOC, projectId: null, requester: reader });
    expect(access.principalFor).not.toHaveBeenCalled();
    expect(permissions.scopeFor).not.toHaveBeenCalled();
    // Nothing restricted on the chain, for the root and the subtree alike — the share tree's rule.
    expect(findFirst.mock.calls[0][0]).toMatchObject({ where: { id: DOC, AND: [{ restrictedBy: { isEmpty: true } }] } });
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { workspaceId: WS, archivedAt: null, path: { startsWith: `/${DOC}/` }, AND: [{ restrictedBy: { isEmpty: true } }] },
    });
    // A link names a page: a project scope through one is empty.
    await expect(scope.documents({ workspaceId: WS, scope: 'project', documentId: null, projectId: 'p-1', requester: reader })).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('exports one page as itself, and nothing for a root in another workspace', async () => {
    const root = { id: DOC, workspaceId: WS, path: `/${DOC}/`, archivedAt: null, parentId: 'p', title: 'Root', position: 2, category: 'guide' };
    const prisma = { document: { findFirst: vi.fn(async () => root), findMany: vi.fn() } };
    const { scope } = scopeService(prisma);
    await expect(
      scope.documents({ workspaceId: WS, scope: 'page', documentId: DOC, projectId: null, requester: REQUESTER }),
    ).resolves.toEqual([{ id: DOC, parentId: 'p', title: 'Root', position: 2, category: 'guide' }]);
    await expect(
      scope.documents({ workspaceId: OTHER_WS, scope: 'subtree', documentId: DOC, projectId: null, requester: REQUESTER }),
    ).resolves.toEqual([]);
    expect(prisma.document.findMany).not.toHaveBeenCalled();
  });

  it('reads the named branch where a page has it, else its default, skipping a draft head', async () => {
    const prisma = {
      document: {
        findMany: vi.fn(async () => [
          { id: 'a', defaultBranch: 'main', branches: [{ id: 'a-main', name: 'main', headRevisionId: 'ra1' }, { id: 'a-next', name: 'next', headRevisionId: 'ra2' }] },
          { id: 'b', defaultBranch: 'main', branches: [{ id: 'b-main', name: 'main', headRevisionId: 'rb-draft' }] },
          { id: 'c', defaultBranch: 'main', branches: [] },
        ]),
      },
      documentRevision: {
        findMany: vi.fn(async (q: { where: { id?: unknown; branchId?: unknown } }) =>
          q.where.id
            ? [
                { id: 'ra2', status: 'indexed' },
                { id: 'rb-draft', status: 'draft' },
              ]
            : [{ id: 'rb-old', branchId: 'b-main' }],
        ),
      },
    };
    const out = await new ExportScopeService(prisma as never, {} as never, {} as never).revisions(['a', 'b', 'c'], 'next');
    expect(Object.fromEntries(out)).toEqual({
      a: { revisionId: 'ra2', branch: 'next' },
      b: { revisionId: 'rb-old', branch: 'main' },
    });
  });
});

// ------------------------------------------------------------------ the archive

const page = (over: Partial<PackagedPage> = {}): PackagedPage => ({
  documentId: 'a',
  title: 'Guide',
  category: 'guide',
  parentId: null,
  position: 0,
  depth: 0,
  slugPath: 'guide',
  revisionId: 'rev-a',
  branch: 'main',
  source: '---\ntags: [x]\n---\n# Guide\n',
  markdown: '# Guide\n',
  ...over,
});

describe('export packaging', () => {
  it('writes a manifest in reading order that an import can rebuild the tree from', () => {
    const manifest = buildManifest({
      workspaceId: WS,
      scope: 'subtree',
      rootDocumentId: 'a',
      projectId: null,
      branch: null,
      title: 'Guide',
      exportedAt: new Date('2026-10-13T12:00:00Z'),
      pages: [page(), page({ documentId: 'b', title: 'Install', parentId: 'a', depth: 1, slugPath: 'guide/install', revisionId: 'rev-b' })],
      attachments: [{ id: 'att', documentId: 'b', filename: 'shot.png', contentType: 'image/png', sizeBytes: 10 }],
    });
    expect(manifest).toMatchObject({ format: 'knowledge-export', version: 1, scope: 'subtree', rootDocumentId: 'a' });
    expect(manifest.pages.map((p) => [p.documentId, p.parentId, p.depth, p.path])).toEqual([
      ['a', null, 0, 'pages/guide.md'],
      ['b', 'a', 1, 'pages/guide/install.md'],
    ]);
    expect(manifest.pages[1].attachments).toEqual([
      { id: 'att', filename: 'shot.png', contentType: 'image/png', sizeBytes: 10, path: 'attachments/att/shot.png' },
    ]);
  });

  it('zips under one top folder, and no name can climb out of it', () => {
    const zip = unzipSync(
      zipArchive(archiveRoot('Install Guide'), [
        { path: 'manifest.json', bytes: new TextEncoder().encode('{}') },
        { path: attachmentArchivePath({ id: 'att', filename: '../../etc/passwd' }), bytes: new Uint8Array([1]) },
      ]),
    );
    expect(Object.keys(zip).sort()).toEqual(['install-guide/attachments/att/_.._etc_passwd', 'install-guide/manifest.json']);
    expect(safeFilename('a\\b:c*?.txt')).toBe('a_b_c_.txt');
    expect(safeFilename('...')).toBe('file');
    expect(pdfAssetName({ id: 'att', filename: 'Shot.PNG' })).toBe('asset-att.png');
  });
});

// ------------------------------------------------------------------ the build

function buildHarness(opts: { row?: Partial<ExportJob>; gotenberg?: boolean; render?: () => Promise<unknown>; embeds?: unknown; publicEmbeds?: boolean } = {}) {
  let row = jobRow(opts.row);
  const prisma = {
    exportJob: {
      updateMany: vi.fn(async ({ where, data }: { where: { status?: unknown }; data: Partial<ExportJob> }) => {
        const allowed = where.status === undefined || JSON.stringify(where.status).includes(row.status);
        if (!allowed) return { count: 0 };
        row = { ...row, ...data };
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => row),
    },
    publishingSettings: { findUnique: vi.fn(async () => (opts.publicEmbeds ? { allowPublicEmbeds: true } : null)) },
    attachment: {
      findMany: vi.fn(async () => [
        { id: 'img', documentId: 'a', filename: 'shot.png', contentType: 'image/png', sizeBytes: 3, s3Key: 'k-img' },
        { id: 'doc', documentId: 'b', filename: 'spec.pdf', contentType: 'application/pdf', sizeBytes: 4, s3Key: 'k-doc' },
      ]),
    },
    documentRevision: {
      findMany: vi.fn(async () => [
        { id: 'rev-a', s3Key: 'src-a' },
        { id: 'rev-b', s3Key: 'src-b' },
      ]),
    },
  };
  const scope = {
    documents: vi.fn(async () => [
      { id: 'a', parentId: null, title: 'Guide', position: 0, category: 'guide' },
      { id: 'b', parentId: 'a', title: 'Install', position: 0, category: 'guide' },
    ]),
    revisions: vi.fn(
      async () =>
        new Map([
          ['a', { revisionId: 'rev-a', branch: 'main' }],
          ['b', { revisionId: 'rev-b', branch: 'main' }],
        ]),
    ),
  };
  const written: { key: string; bytes: Uint8Array; type: string }[] = [];
  const storage = {
    getObjectText: vi.fn(async (key: string) => (key === 'src-a' ? '---\ntags: [x]\n---\n# Guide\n' : 'Install body\n')),
    getObjectBytes: vi.fn(async (key: string) => new TextEncoder().encode(key)),
    putObjectBytes: vi.fn(async (key: string, bytes: Uint8Array, type: string) => {
      written.push({ key, bytes, type });
    }),
    purgeObjectVersions: vi.fn(async () => undefined),
  };
  const renderer = {
    render: vi.fn(opts.render ?? (async () => ({ files: [{ path: 'index.html', content: '<html></html>' }, { path: 'footer.html', content: '<html></html>' }] }))),
  };
  const gotenberg = { configured: opts.gotenberg ?? false, htmlToPdf: vi.fn(async () => new TextEncoder().encode('%PDF-1.7')) };
  const events = { publish: vi.fn(async () => undefined) };
  const svc = new ExportBuildService(
    prisma as never,
    storage as never,
    scope as never,
    renderer as never,
    gotenberg as never,
    events as never,
    (opts.embeds ?? { publicMarkdown: vi.fn(async (md: string) => md), exportSnapshots: vi.fn(async () => []) }) as never,
    configOf() as never,
  );
  return { svc, row: () => row, written, renderer, gotenberg, events, storage, scope };
}

describe('ExportBuildService', () => {
  it('builds a ZIP end to end and tells the requester alone', async () => {
    const h = buildHarness();
    await h.svc.build('job-1');
    expect(h.row()).toMatchObject({ status: 'completed', stage: null, pageCount: 2 });
    expect(h.row().expiresAt!.getTime() - h.row().completedAt!.getTime()).toBe(72 * 3_600_000);
    expect(h.written[0].key).toBe(`workspaces/${WS}/exports/job-1/install-guide.zip`);

    const zip = unzipSync(h.written[0].bytes);
    expect(Object.keys(zip).sort()).toEqual([
      'install-guide/attachments/doc/spec.pdf',
      'install-guide/attachments/img/shot.png',
      'install-guide/manifest.json',
      'install-guide/pages/guide.md',
      'install-guide/pages/guide/install.md',
    ]);
    // The source as stored, frontmatter included.
    expect(strFromU8(zip['install-guide/pages/guide.md'])).toContain('tags: [x]');
    const manifest = JSON.parse(strFromU8(zip['install-guide/manifest.json'])) as ExportManifest;
    expect(manifest.pages.map((p) => p.documentId)).toEqual(['a', 'b']);
    expect(h.events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'export.completed', userId: ME, subjectId: 'job-1' }));
  });

  it('builds a share link’s job from the link’s scope and tells nobody (#161)', async () => {
    const h = buildHarness({ row: { shareLinkId: 'share-1' } });
    await h.svc.build('job-1');
    expect(h.row().status).toBe('completed');
    expect(h.scope.documents).toHaveBeenCalledWith(expect.objectContaining({ requester: { shareLinkId: 'share-1' } }));
    expect(h.events.publish).not.toHaveBeenCalled();
  });

  it('never rebuilds an export that already finished', async () => {
    const h = buildHarness({ row: { status: 'completed' } });
    await h.svc.build('job-1');
    expect(h.written).toEqual([]);
    expect(h.events.publish).not.toHaveBeenCalled();
  });

  it('prints a PDF through the renderer and Gotenberg, uploading only the images', async () => {
    const h = buildHarness({ row: { format: 'pdf' }, gotenberg: true });
    await h.svc.build('job-1');
    const request = h.renderer.render.mock.calls[0][0] as { format: string; pages: { markdown: string }[]; assets: Record<string, string> };
    expect(request.format).toBe('pdf');
    expect(request.pages[0].markdown).not.toContain('tags:');
    expect(request.assets).toEqual({ img: 'asset-img.png' });
    const files = h.gotenberg.htmlToPdf.mock.calls[0][0] as { name: string; contentType: string }[];
    expect(files.map((f) => [f.name, f.contentType])).toEqual([
      ['index.html', 'text/html'],
      ['footer.html', 'text/html'],
      ['asset-img.png', 'image/png'],
    ]);
    expect(h.written[0]).toMatchObject({ key: `workspaces/${WS}/exports/job-1/install-guide.pdf`, type: 'application/pdf' });
    expect(h.row().status).toBe('completed');
  });

  it('prints embedded designs as images keyed by item, from rewritten markdown (#470)', async () => {
    const embeds = {
      publicMarkdown: vi.fn(async (_md: string, _rev: string, snapshots: boolean) => `<figure data-kn-embed="grid"><a${snapshots ? ' data-kn-item="item-1"' : ''}>Sign-in</a></figure>`),
      exportSnapshots: vi.fn(async () => [{ id: 'item-1', documentId: 'doc-1', snapshotKey: 'k-embed' }]),
    };
    const h = buildHarness({ row: { format: 'pdf' }, gotenberg: true, embeds });
    await h.svc.build('job-1');
    const request = h.renderer.render.mock.calls[0][0] as { pages: { markdown: string }[]; assets: Record<string, string> };
    expect(embeds.publicMarkdown.mock.calls.every((c) => c[2] === true)).toBe(true);
    expect(request.pages[0].markdown).toContain('data-kn-item="item-1"');
    expect(request.assets).toMatchObject({ 'item-1': 'asset-item-1.png' });
    const files = h.gotenberg.htmlToPdf.mock.calls[0][0] as { name: string }[];
    expect(files.map((f) => f.name)).toContain('asset-item-1.png');
    expect(h.storage.getObjectBytes.mock.calls.map((c) => c[0])).toContain('k-embed');
  });

  it('gives a share link’s export snapshots only while the workspace shows embeds publicly (#470)', async () => {
    const embeds = () => ({ publicMarkdown: vi.fn(async (md: string) => md), exportSnapshots: vi.fn(async () => []) });
    const off = embeds();
    await buildHarness({ row: { format: 'html', shareLinkId: 'share-1' }, embeds: off }).svc.build('job-1');
    expect(off.exportSnapshots).not.toHaveBeenCalled();
    expect(off.publicMarkdown.mock.calls.every((c) => c[2] === false)).toBe(true);
    const on = embeds();
    await buildHarness({ row: { format: 'html', shareLinkId: 'share-1' }, embeds: on, publicEmbeds: true }).svc.build('job-1');
    expect(on.exportSnapshots).toHaveBeenCalled();
  });

  it('writes a Word document in the worker, without the renderer or Gotenberg, reading only the images', async () => {
    const h = buildHarness({ row: { format: 'docx' }, gotenberg: false });
    await h.svc.build('job-1');
    expect(h.row()).toMatchObject({ status: 'completed', pageCount: 2 });
    expect(h.renderer.render).not.toHaveBeenCalled();
    expect(h.gotenberg.htmlToPdf).not.toHaveBeenCalled();
    expect(h.storage.getObjectBytes.mock.calls.map((c) => c[0])).toEqual(['k-img']);
    expect(h.written[0]).toMatchObject({
      key: `workspaces/${WS}/exports/job-1/install-guide.docx`,
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const xml = strFromU8(unzipSync(h.written[0].bytes)['word/document.xml']);
    // Frontmatter is not content, and both pages are there in reading order.
    expect(xml).not.toContain('tags:');
    expect(xml.indexOf('Install body')).toBeGreaterThan(xml.indexOf('>Guide<'));
  });

  it('fails a PDF with formatUnavailable when Gotenberg went away after it was queued', async () => {
    const h = buildHarness({ row: { format: 'pdf' }, gotenberg: false });
    await h.svc.build('job-1');
    expect(h.row()).toMatchObject({ status: 'failed', error: { code: 'formatUnavailable' } });
    expect(h.events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'export.failed', userId: ME }));
  });

  it('names a renderer failure as one, and writes nothing', async () => {
    const h = buildHarness({ row: { format: 'html' }, render: async () => Promise.reject(new Error('web renderer answered 500')) });
    await h.svc.build('job-1');
    expect(h.row()).toMatchObject({ status: 'failed', error: { code: 'renderFailed' } });
    expect(h.written).toEqual([]);
  });

  it('bundles HTML with every attachment under assets/', async () => {
    const h = buildHarness({ row: { format: 'html' } });
    await h.svc.build('job-1');
    const request = h.renderer.render.mock.calls[0][0] as { assets: Record<string, string>; pages: { path: string }[] };
    expect(request.assets).toEqual({ img: 'assets/img.png', doc: 'assets/doc.pdf' });
    expect(request.pages.map((p) => p.path)).toEqual(['pages/guide.html', 'pages/guide/install.html']);
    expect(Object.keys(unzipSync(h.written[0].bytes)).sort()).toEqual([
      'install-guide/assets/doc.pdf',
      'install-guide/assets/img.png',
      'install-guide/footer.html',
      'install-guide/index.html',
    ]);
  });
});

// ------------------------------------------------------------------ the sweeper

describe('ExportSweeper', () => {
  it('purges expired files, keeps the row as expired, and fails jobs that lost their worker', async () => {
    const prisma = {
      exportJob: {
        findMany: vi.fn(async () => [{ id: 'old', s3Key: 'workspaces/w/exports/old/a.zip' }]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const storage = { purgeObjectVersions: vi.fn(async () => undefined) };
    const now = new Date('2026-10-13T12:00:00Z');
    const result = await new ExportSweeper(prisma as never, storage as never, configOf() as never).sweep(now);
    expect(result).toEqual({ expired: 1, failed: 1 });
    expect(prisma.exportJob.updateMany.mock.calls[0][0]).toEqual({ where: { id: 'old', status: 'completed' }, data: { status: 'expired' } });
    expect(storage.purgeObjectVersions).toHaveBeenCalledWith('workspaces/w/exports/old/a.zip');
    const lost = prisma.exportJob.updateMany.mock.calls[1][0] as { where: { createdAt: { lt: Date } }; data: { error: { code: string } } };
    expect(lost.where.createdAt.lt).toEqual(new Date(now.getTime() - 120_000));
    expect(lost.data.error.code).toBe('timedOut');
  });
});
