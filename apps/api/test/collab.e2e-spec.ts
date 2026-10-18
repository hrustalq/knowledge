import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import request from 'supertest';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { collabDocName } from '@knowledge/contracts';
import { editorSchema, parseMarkdown } from '@knowledge/editor-schema';
import { BODY_FIELD } from '../src/collab/collab-drafts.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #80 phase 1, end to end against live infra: two API instances behind one
 * Redis, Node providers standing in for browser tabs. A new draft is seeded
 * once from the branch head however many peers race for it, edits converge
 * across instances, and a full restart reloads the draft from PG without
 * duplicating it.
 *
 * Runs as the `AUTH_MODE=none` dev principal in whichever workspace has a
 * project, so every peer is a writer; who may join and write is phase 2's spec. Needs
 * `make infra-up` and the `collab_drafts` table.
 */

// Before the app module is imported: ConfigModule validates env at import time.
process.env.COLLAB_ENABLED = 'true';
process.env.COLLAB_STORE_DEBOUNCE_MS = '100';
process.env.COLLAB_STORE_MAX_DEBOUNCE_MS = '300';

const PAGE = '# Shared\n\n> [!note]\n> Seeded **once**.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';
const dom = new JSDOM('').window.document;

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const bodyOf = (doc: Y.Doc) => yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(BODY_FIELD), editorSchema);

describe('shared drafts over /v1/collab (e2e)', () => {
  const apps: INestApplication[] = [];
  const peers: { provider: HocuspocusProvider; document: Y.Doc; denied?: string }[] = [];
  let prisma: PrismaService;
  let ports: number[];
  let documentId: string;
  let workspaceId: string;
  let name: string;

  async function boot(): Promise<number> {
    const { createE2eApp } = await import('./e2e-app.js');
    const app = await createE2eApp();
    await app.listen(0);
    apps.push(app);
    return (app.getHttpServer().address() as AddressInfo).port;
  }

  function peer(port: number, docName = name) {
    const document = new Y.Doc();
    const p: (typeof peers)[number] = {
      document,
      provider: new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/v1/collab`,
        name: docName,
        document,
        token: 'dev',
        onAuthenticationFailed: ({ reason }) => (p.denied = reason),
      }),
    };
    peers.push(p);
    return p;
  }

  beforeAll(async () => {
    ports = [await boot(), await boot()];
    prisma = apps[0]!.get(PrismaService);
    const project = await prisma.project.findFirstOrThrow({ select: { id: true, workspaceId: true } });
    workspaceId = project.workspaceId;
    const created = await request(apps[0]!.getHttpServer())
      .post('/v1/documents')
      .send({
        workspaceId,
        projectId: project.id,
        title: `Collab ${randomUUID().slice(0, 8)}`,
        content: { mode: 'inline', format: 'markdown', text: PAGE },
      })
      .expect(201);
    documentId = created.body.documentId;
    const branch = await prisma.documentBranch.findFirstOrThrow({ where: { documentId }, select: { id: true } });
    name = collabDocName(workspaceId, documentId, branch.id);
  }, 60_000);

  afterAll(async () => {
    for (const p of peers) p.provider.destroy();
    if (documentId) {
      await prisma.collabDraft.deleteMany({ where: { documentId } });
      await request(apps.at(-1)!.getHttpServer()).post(`/v1/documents/${documentId}/archive`).send({});
    }
    for (const app of apps) await app.close();
  });

  it('seeds a new draft once, however many peers race for it', async () => {
    const [a, b] = ports;
    const racers = [a, b, a, b, a].map((port) => peer(port!));
    await until(() => racers.every((r) => r.provider.isSynced), 'five peers to sync');
    const head = parseMarkdown(PAGE, dom);
    for (const r of racers) expect(bodyOf(r.document).eq(head)).toBe(true);
    expect(await prisma.collabDraft.count({ where: { documentId } })).toBe(1);
  });

  it('converges edits across instances', async () => {
    const [a, b] = ports;
    const [onA, onB] = [peer(a!), peer(b!)];
    await until(() => onA.provider.isSynced && onB.provider.isSynced, 'two peers to sync');
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('typed on A')]);
    onA.document.getXmlFragment(BODY_FIELD).push([paragraph]);
    await until(() => bodyOf(onB.document).textContent.includes('typed on A'), 'the edit to reach B');
    expect(bodyOf(onB.document).eq(bodyOf(onA.document))).toBe(true);
  });

  it('stores the draft and reloads it after a restart without duplicating it', async () => {
    await until(async () => {
      const row = await prisma.collabDraft.findUniqueOrThrow({ where: { documentId_branchId: { documentId, branchId: name.split(':')[3]! } } });
      const stored = new Y.Doc();
      Y.applyUpdate(stored, row.state);
      return bodyOf(stored).textContent.includes('typed on A');
    }, 'the edit to be stored');

    for (const p of peers.splice(0)) p.provider.destroy();
    for (const app of apps.splice(0)) await app.close();
    const port = await boot();
    prisma = apps[0]!.get(PrismaService);

    const back = peer(port);
    await until(() => back.provider.isSynced, 'the reloaded peer to sync');
    const text = bodyOf(back.document).textContent;
    expect(text.split('typed on A')).toHaveLength(2);
    expect(text.split('Seeded once')).toHaveLength(2);
  });

  it('refuses a branch that is not the named document’s', async () => {
    const other = await prisma.documentBranch.findFirstOrThrow({ where: { documentId: { not: documentId } }, select: { id: true } });
    const port = (apps[0]!.getHttpServer().address() as AddressInfo).port;
    const stranger = peer(port, collabDocName(workspaceId, documentId, other.id));
    await until(() => stranger.denied !== undefined, 'the refusal');
    expect(stranger.denied).toBe('forbidden');
    expect(stranger.provider.isSynced).toBe(false);
  });
});
