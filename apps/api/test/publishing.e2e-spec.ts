import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import request from 'supertest';
import type { ExportManifest, PublishingSettingsOverride } from '@knowledge/contracts';
import { ExportWorkerModule } from '../src/export/export-worker.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createE2eApp } from './e2e-app.js';

/**
 * #77 acceptance, end to end against live infra: a share link is read with no
 * credential and stops answering the moment it is revoked, and a ZIP export is
 * built, downloaded and carries the tree it describes. #204: a site's nav,
 * listed a level at a time, never names a page an anonymous reader may not see.
 *
 * Runs as the `AUTH_MODE=none` dev principal in the demo workspace, so it needs
 * `make infra-up` and nothing else: neither path waits for indexing, and the
 * ZIP format needs neither the web renderer nor Gotenberg. The public routes
 * are called with no header at all, which is what an anonymous reader sends.
 * The workspace's publishing switches are turned on for the run and put back
 * as they were. Pages cannot be deleted over the API, so the two this creates
 * are left archived.
 */

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const EXPORT_TIMEOUT_MS = 60_000;

describe('publishing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let savedSettings: PublishingSettingsOverride | null = null;
  let parentId: string;
  let childId: string;
  let outsideId: string;
  const nonce = randomUUID().slice(0, 8);

  const http = () => request(app.getHttpServer());

  async function createPage(projectId: string, title: string, body: string, parent?: string): Promise<string> {
    const res = await http()
      .post('/v1/documents')
      .send({
        workspaceId: WORKSPACE,
        visibility: 'workspace',
        projectId,
        title,
        ...(parent ? { parentId: parent } : {}),
        content: { mode: 'inline', format: 'markdown', text: body },
      })
      .expect(201);
    return res.body.documentId as string;
  }

  beforeAll(async () => {
    // An in-process export consumer, so the build does not depend on whether
    // `make dev`'s worker is up. If it is, either one claims the job.
    app = await createE2eApp([ExportWorkerModule]);
    prisma = app.get(PrismaService);

    const settings = await http().get(`/v1/workspaces/${WORKSPACE}/publishing-settings`).expect(200);
    savedSettings = settings.body.override as PublishingSettingsOverride;
    if (!settings.body.ceiling.sharingEnabled) throw new Error('e2e prerequisite missing: PUBLIC_SHARING_ENABLED=false in apps/api/.env');
    if (!settings.body.ceiling.sitesEnabled) throw new Error('e2e prerequisite missing: PUBLIC_SITES_ENABLED=false in apps/api/.env');
    await http()
      .patch(`/v1/workspaces/${WORKSPACE}/publishing-settings`)
      .send({ allowShareLinks: true, allowPasswordlessShares: true, allowPublicSites: true })
      .expect(200);

    const project = await prisma.project.findFirstOrThrow({ where: { workspaceId: WORKSPACE }, select: { id: true } });
    parentId = await createPage(project.id, `Sundew ${nonce} field guide`, `# Sundew ${nonce} field guide\n\nWhere the sundew ${nonce} grows.\n`);
    childId = await createPage(project.id, `Sundew ${nonce} feeding`, `# Sundew ${nonce} feeding\n\nWhat the sundew ${nonce} eats.\n`, parentId);
    // A page of the same workspace outside the shared subtree.
    outsideId = await createPage(project.id, `Sundew ${nonce} unrelated`, `# Unrelated\n\nNot shared.\n`);
  });

  afterAll(async () => {
    if (savedSettings) await http().patch(`/v1/workspaces/${WORKSPACE}/publishing-settings`).send(savedSettings);
    for (const id of [childId, parentId, outsideId]) if (id) await http().post(`/v1/documents/${id}/archive`).send({});
    await app?.close();
  });

  it('share → anonymous read → revoke → 404', async () => {
    const created = await http().post(`/v1/documents/${parentId}/shares`).send({ includeSubtree: true }).expect(201);
    const token = /\/s\/(kp_[^/?#]+)/.exec(created.body.url as string)?.[1];
    expect(token).toBeDefined();

    const share = await http().get(`/v1/public/shares/${token}`).expect(200);
    expect(share.headers['cache-control']).toContain('no-store');
    expect(share.headers['x-robots-tag']).toContain('noindex');
    expect(share.body.locked).toBe(false);
    expect(share.body.tree.map((n: { documentId: string }) => n.documentId).sort()).toEqual([parentId, childId].sort());

    const page = await http().get(`/v1/public/shares/${token}/pages/${childId}`).expect(200);
    expect(page.body.markdown).toContain(`What the sundew ${nonce} eats.`);
    await http().get(`/v1/public/shares/${token}/pages/${outsideId}`).expect(404);

    await http().delete(`/v1/shares/${created.body.share.id}`).expect(200);
    await http().get(`/v1/public/shares/${token}`).expect(404);
    await http().get(`/v1/public/shares/${token}/pages/${childId}`).expect(404);
  });

  it('site nav a level at a time: a members-only page is never in an anonymous child listing', async () => {
    // The reader reads a version's snapshot rows and nothing else, so the
    // snapshot is written directly: no build, no indexing, no worker. The
    // site needs a project of its own (one site per project).
    const project = await prisma.project.create({ data: { workspaceId: WORKSPACE, name: `Sundew ${nonce} site` } });
    const site = await prisma.publishedSite.create({
      data: { workspaceId: WORKSPACE, projectId: project.id, slug: `sundew-${nonce}`, status: 'live', createdBy: randomUUID() },
    });
    try {
      const version = await prisma.siteVersion.create({
        data: { siteId: site.id, name: 'Latest', slug: 'latest', kind: 'live', status: 'built', builtAt: new Date(), createdBy: site.createdBy },
      });
      await prisma.publishedSite.update({ where: { id: site.id }, data: { defaultVersionId: version.id } });
      const [home, open, secret, under] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const row = (documentId: string, parentId: string | null, position: number, depth: number, slugPath: string, audience = 'public') => ({
        versionId: version.id,
        documentId,
        revisionId: randomUUID(),
        parentId,
        position,
        depth,
        slugPath,
        title: slugPath,
        audience,
      });
      await prisma.siteVersionPage.createMany({
        data: [
          row(home, null, 0, 0, 'home'),
          row(open, home, 0, 1, 'home/open'),
          row(secret, home, 1, 1, 'home/secret', 'members'),
          // Stamped public, but under a members-only page: hidden all the same.
          row(under, secret, 0, 2, 'home/secret/under'),
        ],
      });

      const top = await http().get(`/v1/public/sites/${site.id}/tree`).expect(200);
      expect(top.headers['cache-control']).toContain('no-store');
      expect(top.body.nodes).toEqual([
        { documentId: home, parentId: null, title: 'home', slugPath: 'home', position: 0, childCount: 1 },
      ]);
      const children = await http().get(`/v1/public/sites/${site.id}/tree?parent=${home}`).expect(200);
      expect(children.body.nodes.map((n: { documentId: string }) => n.documentId)).toEqual([open]);
      await http().get(`/v1/public/sites/${site.id}/tree?parent=${secret}`).expect(404);

      const resolved = await http().get(`/v1/public/sites/resolve?slug=sundew-${nonce}&path=/home/open`).expect(200);
      expect(resolved.body.tree.map((n: { documentId: string }) => n.documentId)).toEqual([home, open]);
    } finally {
      await prisma.publishedSite.delete({ where: { id: site.id } });
      await prisma.project.delete({ where: { id: project.id } });
    }
  });

  it('site search facets (#205): category and tag filter inside the snapshot; the rail names only what a reader may see', async () => {
    const project = await prisma.project.create({ data: { workspaceId: WORKSPACE, name: `Sundew ${nonce} facets` } });
    const site = await prisma.publishedSite.create({
      data: { workspaceId: WORKSPACE, projectId: project.id, slug: `sundew-f-${nonce}`, status: 'live', createdBy: randomUUID() },
    });
    try {
      const version = await prisma.siteVersion.create({
        data: { siteId: site.id, name: 'Latest', slug: 'latest', kind: 'live', status: 'built', builtAt: new Date(), createdBy: site.createdBy },
      });
      await prisma.publishedSite.update({ where: { id: site.id }, data: { defaultVersionId: version.id } });
      const [guide, ref, secret] = [randomUUID(), randomUUID(), randomUUID()];
      const row = (documentId: string, position: number, slugPath: string, category: string, tags: string[], audience = 'public') => ({
        versionId: version.id,
        documentId,
        revisionId: randomUUID(),
        parentId: null,
        position,
        depth: 0,
        slugPath,
        title: `Sundew ${slugPath}`,
        searchBody: `How the sundew ${nonce} traps insects.`,
        category,
        tags: tags.map((name) => ({ key: `tag:${name.toLowerCase()}`, name })),
        audience,
      });
      await prisma.siteVersionPage.createMany({
        data: [
          row(guide, 0, 'guide', 'guide', ['Plants', 'Care']),
          row(ref, 1, 'ref', 'reference', ['Plants']),
          row(secret, 2, 'secret', 'guide', ['Hidden'], 'members'),
        ],
      });
      // What the build's swap computes (SiteSearchTextService.indexVersion, a worker service).
      await prisma.$executeRaw`
        UPDATE site_version_pages
        SET search_vector = setweight(to_tsvector('russian', title), 'A') || setweight(to_tsvector('russian', search_body), 'C')
        WHERE version_id = ${version.id}::uuid`;

      const ids = (res: request.Response) => (res.body.results as { documentId: string }[]).map((r) => r.documentId).sort();
      const search = (qs: string) => http().get(`/v1/public/sites/${site.id}/search?q=sundew ${nonce}${qs}`);

      const all = await search('').expect(200);
      expect(ids(all)).toEqual([guide, ref].sort());
      expect(all.body.results.find((r: { documentId: string }) => r.documentId === guide)).toMatchObject({
        category: 'guide',
        tags: [{ key: 'tag:plants', name: 'Plants' }, { key: 'tag:care', name: 'Care' }],
      });
      expect(ids(await search('&category=guide').expect(200))).toEqual([guide]);
      expect(ids(await search('&category=guide&category=reference').expect(200))).toEqual([guide, ref].sort());
      // Folded as the build folded it; facets AND together.
      expect(ids(await search('&tag=CARE').expect(200))).toEqual([guide]);
      expect(ids(await search('&category=reference&tag=care').expect(200))).toEqual([]);
      // The members-only page carries `Hidden`; an anonymous filter for it finds nothing.
      expect(ids(await search('&tag=hidden').expect(200))).toEqual([]);

      for (const extra of [`&projectId=${project.id}`, `&workspaceId=${WORKSPACE}`, '&mode=semantic']) {
        const refused = await search(extra).expect(400);
        expect(refused.body.details?.params).toHaveLength(1);
      }

      const facets = await http().get(`/v1/public/sites/${site.id}/facets`).expect(200);
      expect(facets.body).toEqual({
        categories: [
          { value: 'guide', count: 1 },
          { value: 'reference', count: 1 },
        ],
        tags: [
          { key: 'tag:plants', name: 'Plants', count: 2 },
          { key: 'tag:care', name: 'Care', count: 1 },
        ],
      });
      await http().get(`/v1/public/sites/${site.id}/facets?version=nope`).expect(404);
    } finally {
      await prisma.publishedSite.delete({ where: { id: site.id } });
      await prisma.project.delete({ where: { id: project.id } });
    }
  });

  it(
    'export ZIP → download: the archive holds the manifest and every page source',
    async () => {
      const queued = await http().post(`/v1/documents/${parentId}/exports`).send({ format: 'zip', includeSubtree: true }).expect(201);
      const exportId = queued.body.id as string;

      const deadline = Date.now() + EXPORT_TIMEOUT_MS;
      for (;;) {
        const job = await http().get(`/v1/exports/${exportId}`).expect(200);
        if (job.body.status === 'completed') break;
        if (job.body.status === 'failed') throw new Error(`export failed: ${JSON.stringify(job.body.error)}`);
        if (Date.now() > deadline) throw new Error(`export still ${job.body.status} after ${EXPORT_TIMEOUT_MS}ms`);
        await new Promise((r) => setTimeout(r, 500));
      }

      const download = await http().get(`/v1/exports/${exportId}/download`).expect(200);
      const file = await fetch(download.body.url as string);
      expect(file.ok).toBe(true);
      const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));

      const manifestPath = Object.keys(entries).find((p) => p.endsWith('/manifest.json'));
      expect(manifestPath).toBeDefined();
      const top = manifestPath!.slice(0, -'manifest.json'.length);
      const manifest = JSON.parse(strFromU8(entries[manifestPath!])) as ExportManifest;
      expect(manifest.format).toBe('knowledge-export');
      expect(manifest.scope).toBe('subtree');
      expect(manifest.rootDocumentId).toBe(parentId);
      expect(manifest.pages.map((p) => p.documentId)).toEqual([parentId, childId]);
      expect(manifest.pages[1].parentId).toBe(parentId);
      for (const p of manifest.pages) {
        const source = entries[`${top}${p.path}`];
        expect(source, p.path).toBeDefined();
        expect(strFromU8(source)).toContain(`sundew ${nonce}`);
      }
    },
    EXPORT_TIMEOUT_MS + 10_000,
  );

  it(
    'share → download (#161): off by default, the link’s subtree only, and dead the moment download is switched off',
    async () => {
      const created = await http().post(`/v1/documents/${parentId}/shares`).send({ includeSubtree: true }).expect(201);
      const token = /\/s\/(kp_[^/?#]+)/.exec(created.body.url as string)?.[1];
      expect(created.body.share.allowDownload).toBe(false);
      expect((await http().get(`/v1/public/shares/${token}`).expect(200)).body.download).toBeNull();
      await http().post(`/v1/public/shares/${token}/exports`).send({ format: 'zip' }).expect(404);

      await http().patch(`/v1/shares/${created.body.share.id}`).send({ allowDownload: true }).expect(200);
      const view = await http().get(`/v1/public/shares/${token}`).expect(200);
      expect(view.body.download.formats.zip).toBe(true);

      const queued = await http().post(`/v1/public/shares/${token}/exports`).send({ format: 'zip' }).expect(201);
      const exportId = queued.body.id as string;
      // A reader's job names no workspace, page or person.
      expect(Object.keys(queued.body)).not.toEqual(expect.arrayContaining(['workspaceId', 'documentId', 'requestedBy']));

      const deadline = Date.now() + EXPORT_TIMEOUT_MS;
      for (;;) {
        const job = await http().get(`/v1/public/shares/${token}/exports/${exportId}`).expect(200);
        if (job.body.status === 'completed') break;
        if (job.body.status === 'failed') throw new Error(`export failed: ${JSON.stringify(job.body.error)}`);
        if (Date.now() > deadline) throw new Error(`export still ${job.body.status} after ${EXPORT_TIMEOUT_MS}ms`);
        await new Promise((r) => setTimeout(r, 500));
      }

      const download = await http().get(`/v1/public/shares/${token}/exports/${exportId}/download`).expect(302);
      const file = await fetch(download.headers.location as string);
      expect(file.ok).toBe(true);
      const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
      const manifestPath = Object.keys(entries).find((p) => p.endsWith('/manifest.json'))!;
      const manifest = JSON.parse(strFromU8(entries[manifestPath])) as ExportManifest;
      expect(manifest.pages.map((p) => p.documentId).sort()).toEqual([parentId, childId].sort());

      // The job belongs to the link; the creator is only its attribution.
      const row = await prisma.exportJob.findUniqueOrThrow({ where: { id: exportId } });
      expect(row.shareLinkId).toBe(created.body.share.id);

      await http().patch(`/v1/shares/${created.body.share.id}`).send({ allowDownload: false }).expect(200);
      await http().get(`/v1/public/shares/${token}/exports/${exportId}/download`).expect(404);
      await http().get(`/v1/public/shares/${token}/exports/${exportId}`).expect(404);
      await http().delete(`/v1/shares/${created.body.share.id}`).expect(200);
    },
    EXPORT_TIMEOUT_MS + 10_000,
  );
});
