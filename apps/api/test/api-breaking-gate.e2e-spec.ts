import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DocumentsService } from '../src/documents/documents.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { StorageService } from '../src/storage/storage.service.js';
import { createE2eApp } from './e2e-app.js';

/**
 * #78 phase 6 acceptance, end to end against live infra: a spec branch that
 * removes an operation and adds a required parameter shows as breaking in
 * compare and in the merge request's API changes; under a `block` policy the
 * merge is refused with `breaking-api` until an admin acknowledges the source
 * head, and a later push needs a new acknowledgement.
 *
 * Runs as the `AUTH_MODE=none` dev principal in the demo workspace (which is
 * an admin, and skips the approval gate). Needs only `make infra-up`: the
 * diff reads finalized revisions from storage, so nothing has to index. The
 * workspace policy is restored afterwards; the spec is left archived.
 */

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

function spec(variant: 'base' | 'breaking' | 'breaking-more'): string {
  const listParams =
    variant === 'base'
      ? ''
      : `      parameters:
        - { name: tenant, in: query, required: true, schema: { type: string } }
`;
  const remove =
    variant === 'base'
      ? `    delete:
      operationId: deleteInvoice
      responses: { '204': { description: Gone } }
`
      : '';
  const extra =
    variant === 'breaking-more'
      ? `  /refunds:
    get:
      responses: { '200': { description: Refunds } }
`
      : '';
  return `openapi: 3.0.3
info: { title: Gatekeeper ${variant}, version: '1' }
paths:
  /invoices:
    get:
      operationId: listInvoices
${listParams}      responses: { '200': { description: Invoices } }
  /invoices/{id}:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    get:
      responses: { '200': { description: One invoice } }
${remove}${extra}`;
}

describe('breaking API changes gate a spec merge (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let documentId: string;
  let pageId: string;
  let mergeRequestId: string;
  let baseRevisionId: string;
  let savedPolicy: string | null = null;
  const nonce = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());

  async function push(branch: string, text: string): Promise<string> {
    const docs = app.get(DocumentsService);
    const draft = await docs.createRevision(documentId, { branch, contentType: 'application/vnd.oai.openapi+yaml' });
    const row = await prisma.documentRevision.findUniqueOrThrow({ where: { id: draft.revisionId } });
    await app.get(StorageService).putObjectText(row.s3Key, text, row.contentType);
    await docs.finalizeRevision(documentId, draft.revisionId);
    return draft.revisionId;
  }
  const apiChanges = async () => (await http().get(`/v1/merge-requests/${mergeRequestId}/api-changes`).expect(200)).body;
  const setPolicy = (policy: string | null) =>
    http().patch(`/v1/workspaces/${WORKSPACE}/api-settings`).send({ apiBreakingChangePolicy: policy }).expect(200);

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    const settings = await prisma.workspaceSettings.findUnique({ where: { workspaceId: WORKSPACE } });
    savedPolicy = settings?.apiBreakingChangePolicy ?? null;

    const project = await prisma.project.findFirstOrThrow({ where: { workspaceId: WORKSPACE }, select: { id: true } });
    const created = await http()
      .post('/v1/documents')
      .send({
        workspaceId: WORKSPACE,
        visibility: 'workspace',
        projectId: project.id,
        title: `Gatekeeper ${nonce}`,
        kind: 'openapi',
        content: { mode: 'inline', format: 'yaml', text: spec('base') },
      })
      .expect(201);
    documentId = created.body.documentId;
    baseRevisionId = created.body.revisionId;
    const page = await http()
      .post('/v1/documents')
      .send({
        workspaceId: WORKSPACE,
        visibility: 'workspace',
        projectId: project.id,
        title: `Gatekeeper page ${nonce}`,
        content: { mode: 'inline', format: 'markdown', text: '# A page\n' },
      })
      .expect(201);
    pageId = page.body.documentId;

    await http().post(`/v1/documents/${documentId}/branches`).send({ name: 'breaking' }).expect(201);
    await push('breaking', spec('breaking'));
    const mr = await http()
      .post(`/v1/documents/${documentId}/merge-requests`)
      .send({ sourceBranch: 'breaking', title: `Break the gatekeeper ${nonce}` })
      .expect(201);
    mergeRequestId = mr.body.mergeRequest.mergeRequestId;
  }, 60_000);

  afterAll(async () => {
    if (app) {
      await setPolicy(savedPolicy);
      for (const id of [documentId, pageId]) if (id) await http().post(`/v1/documents/${id}/archive`).send({});
      await app.close();
    }
  });

  it('compare carries the classified diff for a spec', async () => {
    const head = await prisma.documentBranch.findFirstOrThrow({ where: { documentId, name: 'breaking' } });
    const res = await http()
      .get(`/v1/documents/${documentId}/compare`)
      .query({ from: baseRevisionId, to: head.headRevisionId, mode: 'merge-base' })
      .expect(200);
    expect(res.body.api.summary.breaking).toBe(2);
    expect(res.body.api.changes.map((c: { rule: string }) => c.rule).sort()).toEqual([
      'operation-removed',
      'required-param-added',
    ]);
  });

  it('GET /v1/api-specs/:id/diff answers the same, and a page is not diffable', async () => {
    const res = await http().get(`/v1/api-specs/${documentId}/diff`).query({ from: baseRevisionId }).expect(200);
    // `to` defaults to the default-branch head, which is still the base.
    expect(res.body.summary).toEqual({ breaking: 0, nonBreaking: 0, info: 0 });
    const page = await prisma.document.findUniqueOrThrow({ where: { id: pageId }, include: { branches: true } });
    await http().get(`/v1/api-specs/${pageId}/diff`).query({ from: page.branches[0].headRevisionId }).expect(400);
  });

  it('under warn, the merge request shows the changes and is not blocked', async () => {
    await setPolicy(null);
    const body = await apiChanges();
    expect(body).toMatchObject({ applicable: true, policy: 'warn', blocked: false, ack: null });
    expect(body.diff.summary.breaking).toBe(2);
  });

  it('under block, merging is refused with breaking-api until an admin acknowledges', async () => {
    await setPolicy('block');
    expect((await apiChanges()).blocked).toBe(true);

    const refused = await http().post(`/v1/merge-requests/${mergeRequestId}/merge`).send({}).expect(409);
    expect(refused.body.details).toMatchObject({ reason: 'breaking-api', breakingCount: 2 });

    const acked = await http().post(`/v1/merge-requests/${mergeRequestId}/breaking-ack`).send({}).expect(201);
    expect(acked.body).toMatchObject({ blocked: false, ack: { current: true } });
  });

  it('a later push makes the acknowledgement stale', async () => {
    await push('breaking', spec('breaking-more'));
    const body = await apiChanges();
    expect(body).toMatchObject({ blocked: true, ack: { current: false } });
    await http().post(`/v1/merge-requests/${mergeRequestId}/merge`).send({}).expect(409);
  });

  it('acknowledged again, it merges', async () => {
    await http().post(`/v1/merge-requests/${mergeRequestId}/breaking-ack`).send({}).expect(201);
    const merged = await http().post(`/v1/merge-requests/${mergeRequestId}/merge`).send({}).expect(201);
    expect(merged.body.mergeRequest.status).toBe('merged');
  });

  it('a page merge request is not applicable', async () => {
    await http().post(`/v1/documents/${pageId}/branches`).send({ name: 'edit' }).expect(201);
    const docs = app.get(DocumentsService);
    const draft = await docs.createRevision(pageId, { branch: 'edit', contentType: 'text/markdown' });
    const row = await prisma.documentRevision.findUniqueOrThrow({ where: { id: draft.revisionId } });
    await app.get(StorageService).putObjectText(row.s3Key, '# A page, edited\n', 'text/markdown');
    await docs.finalizeRevision(pageId, draft.revisionId);
    const mr = await http()
      .post(`/v1/documents/${pageId}/merge-requests`)
      .send({ sourceBranch: 'edit', title: `Edit ${nonce}` })
      .expect(201);
    const res = await http().get(`/v1/merge-requests/${mr.body.mergeRequest.mergeRequestId}/api-changes`).expect(200);
    expect(res.body).toMatchObject({ applicable: false, diff: null, blocked: false });
    await http().post(`/v1/merge-requests/${mr.body.mergeRequest.mergeRequestId}/breaking-ack`).send({}).expect(400);
    await http().post(`/v1/merge-requests/${mr.body.mergeRequest.mergeRequestId}/close`).send({});
  });
});
