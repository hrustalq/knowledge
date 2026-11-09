import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createE2eApp } from './e2e-app.js';

/**
 * #818: the draft's presigned PUT stays valid after finalize, so its holder can
 * write new bytes to the finalized revision's key. Reads pin the version
 * finalize hashed, so the page keeps serving what was finalized.
 *
 * The overwrite happens before the first read on purpose: the content read
 * cache is keyed by revision, and a warm entry would hide an unpinned read.
 * Needs `make infra-up` (Postgres + MinIO); runs as the `AUTH_MODE=none` dev
 * principal in the demo workspace and archives its page after.
 */

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

describe('revision version pin (e2e, #818)', () => {
  let app: INestApplication;
  let documentId: string;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createE2eApp();
    const project = await app.get(PrismaService).project.findFirstOrThrow({ where: { workspaceId: WORKSPACE }, select: { id: true } });
    const res = await http()
      .post('/v1/documents')
      .send({ workspaceId: WORKSPACE, projectId: project.id, title: `Version pin ${randomUUID().slice(0, 8)}` })
      .expect(201);
    documentId = res.body.documentId as string;
  });

  afterAll(async () => {
    if (documentId) await http().post(`/v1/documents/${documentId}/archive`).send({});
    await app?.close();
  });

  it('a PUT to the upload URL after finalize does not change the content', async () => {
    const upload = await http()
      .post(`/v1/documents/${documentId}/uploads`)
      .send({ contentType: 'text/markdown', filename: 'source.md' })
      .expect(201);
    const { revisionId } = upload.body as { revisionId: string };
    const url = upload.body.upload.url as string;
    const put = (body: string) =>
      fetch(url, { method: 'PUT', body, headers: { 'content-type': 'text/markdown' } }).then((r) => expect(r.ok).toBe(true));

    await put('# Reviewed\n\nThe finalized body.\n');
    await http().post(`/v1/documents/${documentId}/revisions/${revisionId}/finalize`).send({}).expect(201);
    await put('# Tampered\n\nWritten after finalize.\n');

    const content = await http().get(`/v1/documents/${documentId}/content`).expect(200);
    expect(content.body.revisionId).toBe(revisionId);
    expect(content.body.markdown).toContain('The finalized body.');
    expect(content.body.markdown).not.toContain('Tampered');
  });
});
