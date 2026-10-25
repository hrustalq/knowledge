import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { collabDocName, collabToken } from '@knowledge/contracts';
import { SUGGESTIONS_FIELD } from '@knowledge/editor-schema/suggestions';
import { BODY_FIELD } from '../src/collab/collab-drafts.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #316 end to end against live infra (two API instances, one Redis): the MCP
 * draft tools over POST /v1/mcp on one instance, a peer in the editor's place
 * on the other. Reading a page with no draft creates none; a suggestion lands
 * in the peer's doc at once, credited, while `knowledge_get_draft` still reads
 * the page as a publish would write it; it is stored; a refused edit writes
 * nothing. Runs as the AUTH_MODE=none dev principal; the tool guards are
 * pinned in mcp-http.spec.ts. Needs `make infra-up`.
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

describe('MCP agents in a shared draft (e2e, #316)', () => {
  const apps: INestApplication[] = [];
  let prisma: PrismaService;
  let ports: number[];
  let documentId: string;
  let branchId: string;
  let peer: { provider: HocuspocusProvider; document: Y.Doc };

  async function boot(): Promise<number> {
    const { createE2eApp } = await import('./e2e-app.js');
    const app = await createE2eApp();
    await app.listen(0);
    apps.push(app);
    return (app.getHttpServer().address() as AddressInfo).port;
  }

  /** One tool call over the HTTP transport, as an MCP client makes it. */
  async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; value: unknown; text: string }> {
    const res = await request(apps[0]!.getHttpServer())
      .post('/v1/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      .expect(200);
    const result = res.body.result as { isError?: boolean; content: { text: string }[] };
    const body = result.content[0]!.text;
    let value: unknown = null;
    try {
      value = JSON.parse(body);
    } catch {
      // A refusal is prose.
    }
    return { isError: result.isError === true, value, text: body };
  }

  beforeAll(async () => {
    ports = [await boot(), await boot()];
    prisma = apps[0]!.get(PrismaService);
    const project = await prisma.project.findFirstOrThrow({ select: { id: true, workspaceId: true } });
    const created = await request(apps[0]!.getHttpServer())
      .post('/v1/documents')
      .send({
        workspaceId: project.workspaceId,
        visibility: 'workspace',
        projectId: project.id,
        title: `MCP draft ${randomUUID().slice(0, 8)}`,
        content: { mode: 'inline', format: 'markdown', text: 'The head.\n\nThe **owner** is billing.\n' },
      })
      .expect(201);
    documentId = created.body.documentId;
    branchId = (await prisma.documentBranch.findFirstOrThrow({ where: { documentId }, select: { id: true } })).id;
  }, 60_000);

  afterAll(async () => {
    peer?.provider.destroy();
    if (documentId) {
      await prisma.collabDraft.deleteMany({ where: { documentId } });
      await request(apps[0]!.getHttpServer()).post(`/v1/documents/${documentId}/archive`).send({});
    }
    for (const app of apps) await app.close();
  });

  it('reads a page nobody has opened as no draft, and creates none', async () => {
    const { value } = await call('knowledge_get_draft', { documentId });
    expect(value).toEqual({ draft: null });
    expect(await prisma.collabDraft.count({ where: { documentId } })).toBe(0);
  });

  it('puts a suggestion in front of a peer on the other instance, left out of what a publish writes', async () => {
    const document = new Y.Doc();
    const workspaceId = (await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).workspaceId;
    peer = {
      document,
      provider: new HocuspocusProvider({
        url: `ws://127.0.0.1:${ports[1]}/v1/collab`,
        name: collabDocName(workspaceId, documentId, branchId),
        document,
        token: collabToken('dev', null),
      }),
    };
    await until(() => peer.provider.isSynced, 'the peer to sync');

    const suggested = await call('knowledge_suggest_draft_edit', {
      documentId,
      op: 'replace',
      anchor: 'The **owner** is billing.',
      markdown: 'The **owner** is payments.',
    });
    expect(suggested.isError).toBe(false);
    const { suggestionId } = suggested.value as { suggestionId: string };

    await until(() => text(document).includes('payments'), 'the suggestion to reach the peer');
    expect(text(document)).not.toContain('billing');
    const entry = document.getMap<Y.Map<unknown>>(SUGGESTIONS_FIELD).get(suggestionId);
    expect(entry?.get('agent')).toEqual({ key: 'mcp', name: 'MCP' });
    expect(entry?.get('state')).toBe('ready');

    const { value } = await call('knowledge_get_draft', { documentId });
    expect(value).toMatchObject({
      draft: {
        branch: 'main',
        markdown: 'The head.\n\nThe **owner** is billing.',
        // No `editing` here: it counts this instance's peers (doc 56 § Limits), and the peer is on the other one.
        suggestions: [{ id: suggestionId, agent: 'MCP', markdown: 'The **owner** is payments.', replaces: 'The owner is billing.' }],
      },
    });

    await until(async () => {
      const row = await prisma.collabDraft.findUniqueOrThrow({ where: { documentId_branchId: { documentId, branchId } } });
      const stored = new Y.Doc();
      Y.applyUpdate(stored, row.state);
      return text(stored).includes('payments') && stored.getMap(SUGGESTIONS_FIELD).has(suggestionId);
    }, 'the suggestion to be stored');
  });

  it('writes nothing for an edit it refuses', async () => {
    const before = text(peer.document);
    const refused = await call('knowledge_suggest_draft_edit', {
      documentId,
      op: 'insert_after',
      anchor: 'Nowhere on this page.',
      markdown: 'Lost.',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/not found/);
    await new Promise((r) => setTimeout(r, 300));
    expect(text(peer.document)).toBe(before);
    expect(peer.document.getMap(SUGGESTIONS_FIELD).size).toBe(1);
  });
});
