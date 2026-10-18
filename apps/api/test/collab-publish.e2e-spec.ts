import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { collabDocName, type CollabDraftInfo, type ListCollabDraftsResponse } from '@knowledge/contracts';
import { BODY_FIELD } from '../src/collab/collab-drafts.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { StorageService } from '../src/storage/storage.service.js';

/**
 * #80 phase 4, end to end against live infra (two API instances, one Redis):
 * publishing a shared draft writes an ordinary revision and rebases the draft,
 * edits made after the published snapshot stay unpublished, a moved head is
 * the usual 409, a content-equal publish still rebases, and discarding the
 * draft closes its peers on every instance with `reset` and reseeds it from
 * the head. Runs as the AUTH_MODE=none dev principal. Needs `make infra-up`.
 */

process.env.COLLAB_ENABLED = 'true';
process.env.COLLAB_STORE_DEBOUNCE_MS = '100';
process.env.COLLAB_STORE_MAX_DEBOUNCE_MS = '300';

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const text = (doc: Y.Doc) => doc.getXmlFragment(BODY_FIELD).toString();

function type(doc: Y.Doc, words: string) {
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(words)]);
  doc.getXmlFragment(BODY_FIELD).push([paragraph]);
}

const encode = (doc: Y.Doc) => Buffer.from(Y.encodeSnapshot(Y.snapshot(doc))).toString('base64');

describe('publishing a shared draft (e2e)', () => {
  const apps: INestApplication[] = [];
  const peers: { provider: HocuspocusProvider; document: Y.Doc; closed: string[] }[] = [];
  let prisma: PrismaService;
  let ports: number[];
  let documentId: string;
  let workspaceId: string;
  let branchId: string;
  let name: string;

  const http = () => request(apps[0]!.getHttpServer());

  async function boot(): Promise<number> {
    const { createE2eApp } = await import('./e2e-app.js');
    const app = await createE2eApp();
    await app.listen(0);
    apps.push(app);
    return (app.getHttpServer().address() as AddressInfo).port;
  }

  function peer(port: number) {
    const document = new Y.Doc();
    const p: (typeof peers)[number] = {
      document,
      closed: [],
      provider: new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/v1/collab`,
        name,
        document,
        token: 'dev',
        onClose: ({ event }) => void p.closed.push(event.reason),
      }),
    };
    // What the editor's caret extension does; the server fills in who this is.
    p.provider.setAwarenessField('user', {});
    peers.push(p);
    return p;
  }

  async function draft(): Promise<CollabDraftInfo> {
    const res = await http().get(`/v1/documents/${documentId}/drafts`).expect(200);
    return (res.body as ListCollabDraftsResponse).drafts.find((d) => d.branchId === branchId)!;
  }

  /** The editor's publish: a revision naming the draft and snapshot, its bytes, then finalize. */
  async function publish(body: string, ifMatch: string | null, collab?: { draftId: string; snapshot: string }) {
    const created = await http()
      .post(`/v1/documents/${documentId}/revisions`)
      .set(ifMatch ? { 'If-Match': ifMatch } : {})
      .send({ message: 'from the draft', contentType: 'text/markdown', ...(collab && { collabDraftId: collab.draftId, draftSnapshot: collab.snapshot }) });
    if (created.status !== 201) return created;
    const row = await prisma.documentRevision.findUniqueOrThrow({ where: { id: created.body.revisionId } });
    await apps[0]!.get(StorageService).putObjectText(row.s3Key, body, 'text/markdown');
    return http().post(`/v1/documents/${documentId}/revisions/${created.body.revisionId}/finalize`).expect(201);
  }

  /** Until the server's copy holds what `doc` holds, so the row's snapshot is comparable. */
  const stored = (words: string) =>
    until(async () => {
      const row = await prisma.collabDraft.findUniqueOrThrow({ where: { documentId_branchId: { documentId, branchId } } });
      const doc = new Y.Doc();
      Y.applyUpdate(doc, row.state);
      return text(doc).includes(words);
    }, `"${words}" to be stored`);

  beforeAll(async () => {
    ports = [await boot(), await boot()];
    prisma = apps[0]!.get(PrismaService);
    const project = await prisma.project.findFirstOrThrow({ select: { id: true, workspaceId: true } });
    workspaceId = project.workspaceId;
    const created = await http()
      .post('/v1/documents')
      .send({
        workspaceId,
        projectId: project.id,
        title: `Publish ${randomUUID().slice(0, 8)}`,
        content: { mode: 'inline', format: 'markdown', text: '# Published\n\nThe head.\n' },
      })
      .expect(201);
    documentId = created.body.documentId;
    branchId = (await prisma.documentBranch.findFirstOrThrow({ where: { documentId }, select: { id: true } })).id;
    name = collabDocName(workspaceId, documentId, branchId);
  }, 60_000);

  afterAll(async () => {
    for (const p of peers) p.provider.destroy();
    if (documentId) {
      await prisma.collabDraft.deleteMany({ where: { documentId } });
      await http().post(`/v1/documents/${documentId}/archive`).send({});
    }
    for (const app of apps) await app.close();
  });

  it('opens a draft with nothing unpublished, fields included', async () => {
    const a = peer(ports[0]!);
    await until(() => a.provider.isSynced, 'A to sync');
    expect(String(a.document.getMap('meta').get('title'))).toMatch(/^Publish /);
    const info = await draft();
    expect(info.hasUnpublishedChanges).toBe(false);
    expect(info.activePeers).toBe(1);
  });

  it('publishes as an ordinary revision and rebases the draft; later edits stay unpublished', async () => {
    const [a, b] = [peers[0]!, peer(ports[1]!)];
    await until(() => b.provider.isSynced, 'B to sync');
    type(a.document, 'Written by A');
    await stored('Written by A');
    expect((await draft()).hasUnpublishedChanges).toBe(true);

    const before = await draft();
    const snapshot = encode(a.document);
    const fin = await publish('# Published\n\nThe head.\n\nWritten by A\n', before.baseRevisionId, { draftId: before.draftId, snapshot });
    expect(fin.body.deduplicated).toBe(false);

    const after = await draft();
    expect(after.baseRevisionId).toBe(fin.body.revisionId);
    expect(after.hasUnpublishedChanges).toBe(false);
    expect(after.contributors).toEqual([]);
    const revision = await prisma.documentRevision.findUniqueOrThrow({ where: { id: fin.body.revisionId } });
    expect(revision.collabDraftId).toBe(before.draftId);
    expect(revision.coAuthorIds).toEqual(before.contributors);
    const branch = await prisma.documentBranch.findUniqueOrThrow({ where: { id: branchId } });
    expect(branch.headRevisionId).toBe(fin.body.revisionId);

    // B typed after the snapshot A published: still a change.
    type(b.document, 'Typed by B after the publish');
    await stored('Typed by B after the publish');
    expect((await draft()).hasUnpublishedChanges).toBe(true);
  });

  it('refuses a draft that is not this branch’s', async () => {
    const res = await http()
      .post(`/v1/documents/${documentId}/revisions`)
      .send({ contentType: 'text/markdown', collabDraftId: randomUUID(), draftSnapshot: encode(peers[0]!.document) });
    expect(res.status).toBe(400);
  });

  it('answers a moved head with the usual 409, then publishes on top of it', async () => {
    const { baseRevisionId, draftId } = await draft();
    // Someone published past the draft (MCP, a merge, a connector).
    const elsewhere = await publish('# Published\n\nChanged elsewhere.\n', baseRevisionId);
    const stale = await publish('# ignored\n', baseRevisionId, { draftId, snapshot: encode(peers[0]!.document) });
    expect(stale.status).toBe(409);
    expect(stale.body.details.currentHeadRevisionId).toBe(elsewhere.body.revisionId);
    expect((await draft()).baseRevisionId).toBe(baseRevisionId);

    const onTop = await publish('# Published\n\nOn top.\n', elsewhere.body.revisionId, { draftId, snapshot: encode(peers[0]!.document) });
    expect((await draft()).baseRevisionId).toBe(onTop.body.revisionId);
  });

  it('rebases on a content-equal publish too', async () => {
    const { baseRevisionId, draftId } = await draft();
    const same = await publish('# Published\n\nOn top.\n', baseRevisionId, { draftId, snapshot: encode(peers[0]!.document) });
    expect(same.body.deduplicated).toBe(true);
    expect(same.body.revisionId).toBe(baseRevisionId);
    const info = await draft();
    expect(info.baseRevisionId).toBe(baseRevisionId);
    expect(info.hasUnpublishedChanges).toBe(false);
  });

  it('discards the draft: peers on every instance close with reset, and it reseeds from the head', async () => {
    const [a, b] = peers;
    await http().delete(`/v1/documents/${documentId}/drafts/${branchId}`).expect(204);
    await until(() => a!.closed.includes('reset') && b!.closed.includes('reset'), 'both instances to close their peer');

    const fresh = peer(ports[1]!);
    await until(() => fresh.provider.isSynced, 'a fresh peer to sync');
    expect(text(fresh.document)).toContain('On top.');
    expect(text(fresh.document)).not.toContain('Typed by B');
    const info = await draft();
    expect(info.hasUnpublishedChanges).toBe(false);

    // The old doc, if any instance still held it, can no longer write back.
    const row = await prisma.collabDraft.findUniqueOrThrow({ where: { documentId_branchId: { documentId, branchId } } });
    expect(row.resetAt).not.toBeNull();
    await http().delete(`/v1/documents/${documentId}/drafts/${randomUUID()}`).expect(404);
  });
});
