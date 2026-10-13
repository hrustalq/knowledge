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
 * built, downloaded and carries the tree it describes.
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
    await http()
      .patch(`/v1/workspaces/${WORKSPACE}/publishing-settings`)
      .send({ allowShareLinks: true, allowPasswordlessShares: true })
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
});
