import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { IngestionWorkerModule } from '../src/ingestion/ingestion-worker.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createE2eApp } from './e2e-app.js';

/**
 * #66 acceptance, end to end against live infra: a verified page carries
 * `trust.status = 'verified'` in search, and an archived page leaves search
 * until it is unarchived.
 *
 * Runs as the `AUTH_MODE=none` dev principal in the demo workspace, so it needs
 * `make infra-up` plus the embeddings provider apps/api/.env names — and, if
 * that file sets FULLTEXT_PROVIDER=opensearch, a running OpenSearch node
 * (`make infra-up-opensearch`), or every search answers 500. Pages
 * cannot be deleted over the API, so the page this creates is left archived:
 * out of every list, the tree and search by default.
 */

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const INDEX_TIMEOUT_MS = 120_000;

type Hit = { documentId: string; trust?: { status: string; verifiedAt: string | null; expiresAt: string | null } };

describe('page verification (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let documentId: string;
  const nonce = randomUUID().slice(0, 8);
  const title = `Quillwort ${nonce} calibration runbook`;

  const http = () => request(app.getHttpServer());

  async function search(includeArchived = false): Promise<Hit[]> {
    const res = await http()
      .post('/v1/search')
      .send({ workspaceId: WORKSPACE, query: title, limit: 20, ...(includeArchived ? { filters: { includeArchived: true } } : {}) })
      .expect(200);
    return res.body.results as Hit[];
  }
  const hitFor = (hits: Hit[]) => hits.find((h) => h.documentId === documentId);

  beforeAll(async () => {
    // An in-process ingestion consumer, so indexing does not depend on
    // whether `make dev`'s worker happens to be running.
    app = await createE2eApp([IngestionWorkerModule]);
    prisma = app.get(PrismaService);

    const project = await prisma.project.findFirstOrThrow({ where: { workspaceId: WORKSPACE }, select: { id: true } });
    const created = await http()
      .post('/v1/documents')
      .send({
        workspaceId: WORKSPACE,
        projectId: project.id,
        title,
        content: {
          mode: 'inline',
          format: 'markdown',
          text: `# ${title}\n\nHow to calibrate the quillwort ${nonce} sensor array before a field survey: zero the baseline, record the drift, and file the reading.\n`,
        },
      })
      .expect(201);
    documentId = created.body.documentId;
    const revisionId: string = created.body.revisionId;

    const deadline = Date.now() + INDEX_TIMEOUT_MS;
    for (;;) {
      const rev = await prisma.documentRevision.findUniqueOrThrow({ where: { id: revisionId }, select: { status: true } });
      if (rev.status === 'indexed') break;
      if (rev.status === 'failed') throw new Error(`revision ${revisionId} failed to index`);
      if (Date.now() > deadline) throw new Error(`revision ${revisionId} still ${rev.status} after ${INDEX_TIMEOUT_MS}ms`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }, INDEX_TIMEOUT_MS + 30_000);

  afterAll(async () => {
    if (documentId) await http().post(`/v1/documents/${documentId}/archive`).send({});
    await app?.close();
  });

  it('an indexed, never-verified page reads unverified in search', async () => {
    const hit = hitFor(await search());
    expect(hit).toBeDefined();
    expect(hit!.trust?.status).toBe('unverified');
  });

  it('verify → search shows trust.status = verified with the interval as expiry', async () => {
    await http().post(`/v1/documents/${documentId}/verify`).send({ intervalDays: 30 }).expect(201);

    const hit = hitFor(await search());
    expect(hit?.trust?.status).toBe('verified');
    expect(hit!.trust!.verifiedAt).not.toBeNull();
    const days = (Date.parse(hit!.trust!.expiresAt!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
  });

  it('archive → search excludes the page, includeArchived and GET :id still reach it', async () => {
    await http().post(`/v1/documents/${documentId}/archive`).send({}).expect(201);

    expect(hitFor(await search())).toBeUndefined();
    expect(hitFor(await search(true))).toBeDefined();
    await http().get(`/v1/documents/${documentId}`).expect(200);
  });

  it('unarchive → the page is back in search', async () => {
    await http().post(`/v1/documents/${documentId}/unarchive`).send({}).expect(201);
    expect(hitFor(await search())).toBeDefined();
  });
});
