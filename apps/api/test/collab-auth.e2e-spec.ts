import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { collabDocName, type CollabUser } from '@knowledge/contracts';
import { BODY_FIELD } from '../src/collab/collab-drafts.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #80 phase 2, end to end against live infra: who may join a shared draft and
 * who keeps it, with real people, real `kt_` tickets and real providers.
 *
 * Like page-permissions.e2e-spec.ts it forces `AUTH_MODE=api-key` (the dev
 * principal bypasses everything) and makes its own non-admin people in a
 * fixed workspace:
 *
 *   admin  — workspace admin, not a platform admin
 *   ed     — editor; also holds a read-only key
 *   vic    — viewer
 *
 * Needs `make infra-up` and the `collab_drafts` table. Each run makes a fresh
 * project and page, archives the page and deletes its keys at the end.
 */

const WORKSPACE = '80000000-0000-4080-8080-000000000080';
/** Short enough to wait out, long enough that the acl.changed check below is not the interval's doing. */
const REAUTH_S = 20;

type Person = { id: string; key: string; keyId: string };
type Peer = {
  provider: HocuspocusProvider;
  document: Y.Doc;
  denied?: string;
  closed?: { code: number; reason: string };
};

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (doc: Y.Doc) => doc.getXmlFragment(BODY_FIELD).toString();

describe('who may co-edit a draft over /v1/collab (e2e, #80 phase 2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let port: number;
  const nonce = randomUUID().slice(0, 8);
  const people = {} as Record<'admin' | 'ed' | 'vic', Person>;
  let readKey: Person;
  let documentId: string;
  let branchId: string;
  let name: string;
  const peers: Peer[] = [];

  const http = () => request(app.getHttpServer());
  const as = (p: Person) => ({ Authorization: `Bearer ${p.key}` });

  async function person(handle: string, role: 'admin' | 'editor' | 'viewer'): Promise<Person> {
    const email = `collab-e2e-${handle}@example.test`;
    const user = await prisma.user.upsert({
      where: { email },
      update: { isAdmin: false, emailVerifiedAt: new Date(), disabledAt: null },
      create: { email, displayName: `Collab ${handle}`, isAdmin: false, emailVerifiedAt: new Date() },
    });
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: WORKSPACE, userId: user.id } },
      update: { role },
      create: { workspaceId: WORKSPACE, userId: user.id, role },
    });
    return { id: user.id, ...(await key(user.id, 'write')) };
  }

  async function key(userId: string, scope: 'read' | 'write'): Promise<{ key: string; keyId: string }> {
    const k = `kn_${randomBytes(24).toString('hex')}`;
    const row = await prisma.apiKey.create({
      data: { userId, name: `collab e2e ${nonce}`, keyHash: createHash('sha256').update(k).digest('hex'), prefix: k.slice(0, 11), scope },
    });
    return { key: k, keyId: row.id };
  }

  const ticket = async (p: Person): Promise<string> =>
    (await http().post('/v1/auth/url-ticket').set(as(p)).expect(200)).body.ticket as string;

  /** A provider standing in for a browser tab; `token` is asked afresh on every (re)join. */
  function peer(token: () => Promise<string>, docName = name): Peer {
    const document = new Y.Doc();
    const p: Peer = {
      document,
      provider: new HocuspocusProvider({
        url: `ws://127.0.0.1:${port}/v1/collab`,
        name: docName,
        document,
        token,
        onAuthenticationFailed: ({ reason }) => (p.denied = reason),
        onClose: ({ event }) => (p.closed = { code: event.code, reason: event.reason }),
      }),
    };
    peers.push(p);
    return p;
  }
  const join = (p: Person) => peer(() => ticket(p));
  const joined = (p: Peer) => p.provider.isSynced;

  function type(p: Peer, words: string): void {
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText(words)]);
    p.document.getXmlFragment(BODY_FIELD).push([paragraph]);
  }

  beforeAll(async () => {
    // Before the app module is imported: ConfigModule validates env at import time.
    process.env.AUTH_MODE = 'api-key';
    process.env.COLLAB_ENABLED = 'true';
    process.env.COLLAB_REAUTH_INTERVAL_SECONDS = String(REAUTH_S);
    process.env.AUTH_URL_TICKET_TTL_SEC = '5';
    const [{ createE2eApp }, { PrismaService }] = await Promise.all([import('./e2e-app.js'), import('../src/prisma/prisma.service.js')]);
    app = await createE2eApp();
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
    prisma = app.get(PrismaService);

    await prisma.workspace.upsert({ where: { id: WORKSPACE }, update: {}, create: { id: WORKSPACE, name: 'Collab e2e (#80)' } });
    people.admin = await person('admin', 'admin');
    people.ed = await person('ed', 'editor');
    people.vic = await person('vic', 'viewer');
    readKey = { id: people.ed.id, ...(await key(people.ed.id, 'read')) };
    const project = await prisma.project.create({ data: { workspaceId: WORKSPACE, name: `Collab e2e ${nonce}` } });
    const created = await http()
      .post('/v1/documents')
      .set(as(people.admin))
      .send({
        workspaceId: WORKSPACE,
        projectId: project.id,
        title: `Shared ${nonce}`,
        content: { mode: 'inline', format: 'markdown', text: '# Shared\n\nSeed.\n' },
      })
      .expect(201);
    documentId = created.body.documentId;
    branchId = (await prisma.documentBranch.findFirstOrThrow({ where: { documentId }, select: { id: true } })).id;
    name = collabDocName(WORKSPACE, documentId, branchId);
  }, 60_000);

  afterAll(async () => {
    for (const p of peers) p.provider.destroy();
    if (!app) return;
    await prisma.workspaceMember.updateMany({ where: { workspaceId: WORKSPACE, userId: people.ed?.id }, data: { role: 'editor' } });
    if (documentId) {
      await prisma.collabDraft.deleteMany({ where: { documentId } });
      await http().post(`/v1/documents/${documentId}/archive`).set(as(people.admin)).send({});
    }
    const keyIds = [...Object.values(people), readKey].filter(Boolean).map((p) => p.keyId);
    await prisma.apiKey.deleteMany({ where: { id: { in: keyIds } } });
    await app.close();
  });

  it('answers capabilities with the flag and the schema version', async () => {
    const res = await http().get('/v1/collab/capabilities').set(as(people.vic)).expect(200);
    expect(res.body).toEqual({ enabled: true, schemaVersion: expect.any(String) });
  });

  it('joins an editor read-write, a viewer and a read-only key read-only', async () => {
    const [ed, vic, ro] = [join(people.ed), join(people.vic), join(readKey)];
    await until(() => [ed, vic, ro].every(joined), 'three peers to sync');
    expect(ed.provider.authorizedScope).toBe('read-write');
    expect(vic.provider.authorizedScope).toBe('readonly');
    expect(ro.provider.authorizedScope).toBe('readonly');
  });

  it('drops a read-only peer’s writes on the server', async () => {
    const [ed, vic, ro] = [join(people.ed), join(people.vic), join(readKey)];
    await until(() => [ed, vic, ro].every(joined), 'three peers to sync');
    type(vic, `viewer wrote ${nonce}`);
    type(ro, `read key wrote ${nonce}`);
    // Sent after the refused ones on the same server: once it arrives, they would have.
    type(ed, `editor wrote ${nonce}`);
    await until(() => text(vic.document).includes(`editor wrote ${nonce}`), 'the editor’s edit to reach the viewer');
    await sleep(300);
    expect(text(ed.document)).not.toContain(`viewer wrote ${nonce}`);
    expect(text(ed.document)).not.toContain(`read key wrote ${nonce}`);
    const fresh = join(people.ed);
    await until(() => joined(fresh), 'a fresh peer to sync');
    expect(text(fresh.document)).toContain(`editor wrote ${nonce}`);
    expect(text(fresh.document)).not.toContain(`viewer wrote ${nonce}`);
  });

  it('refuses a reused, an expired or a long-lived token as unauthorized', async () => {
    const once = await ticket(people.ed);
    const first = peer(async () => once);
    await until(() => joined(first), 'the first use to sync');
    const reused = peer(async () => once);
    const apiKey = peer(async () => people.ed.key);
    const expired = await ticket(people.ed);
    await sleep(6_000);
    const late = peer(async () => expired);
    await until(() => [reused, apiKey, late].every((p) => p.denied !== undefined), 'three refusals');
    expect([reused.denied, apiKey.denied, late.denied]).toEqual(['unauthorized', 'unauthorized', 'unauthorized']);
  }, 20_000);

  it('refuses a stranger’s document and a doc name naming the wrong workspace as forbidden', async () => {
    const elsewhere = await prisma.documentBranch.findFirstOrThrow({
      where: { document: { workspaceId: { not: WORKSPACE } } },
      select: { id: true, documentId: true, document: { select: { workspaceId: true } } },
    });
    const stranger = peer(() => ticket(people.ed), collabDocName(elsewhere.document.workspaceId, elsewhere.documentId, elsewhere.id));
    const misnamed = peer(() => ticket(people.ed), collabDocName(elsewhere.document.workspaceId, documentId, branchId));
    await until(() => stranger.denied !== undefined && misnamed.denied !== undefined, 'two refusals');
    expect([stranger.denied, misnamed.denied]).toEqual(['forbidden', 'forbidden']);
  });

  it('attests every caret’s identity from the principal, whatever the client claims', async () => {
    const [ed, vic] = [join(people.ed), join(people.vic)];
    await until(() => joined(ed) && joined(vic), 'two peers to sync');
    ed.provider.setAwarenessField('user', { userId: people.vic.id, name: 'Not Ed', color: '#0a0' });
    const edId = ed.document.clientID;
    await until(() => vic.provider.awareness?.getStates().get(edId)?.user !== undefined, 'ed’s awareness to reach vic');
    const user = vic.provider.awareness!.getStates().get(edId)!.user as CollabUser & { color: string };
    expect(user).toEqual({ userId: people.ed.id, name: 'Collab ed', avatarUrl: null, color: '#0a0' });
  });

  it('closes a demoted editor with access-changed, and rejoins it read-only', async () => {
    const ed = join(people.ed);
    await until(() => joined(ed), 'ed to sync');
    await prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId: WORKSPACE, userId: people.ed.id } },
      data: { role: 'viewer' },
    });
    await until(() => ed.closed !== undefined, 'the re-check to close ed', (REAUTH_S + 5) * 1000);
    // Only the reason crosses a per-document close; the provider always reports 1000.
    expect(ed.closed).toEqual({ code: 1000, reason: 'access-changed' });
    const again = join(people.ed);
    await until(() => joined(again), 'ed to rejoin');
    expect(again.provider.authorizedScope).toBe('readonly');
    await prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId: WORKSPACE, userId: people.ed.id } },
      data: { role: 'editor' },
    });
  }, (REAUTH_S + 15) * 1000);

  it('closes a viewer the page is restricted away from, on acl.changed rather than the interval', async () => {
    const vic = join(people.vic);
    await until(() => joined(vic), 'vic to sync');
    await http()
      .put(`/v1/documents/${documentId}/access`)
      .set(as(people.admin))
      .send({ restricted: true, grants: [{ subjectType: 'user', subjectId: people.ed.id, level: 'edit' }] })
      .expect(200);
    await until(() => vic.closed !== undefined, 'the restriction to close vic', 3_000);
    expect(vic.closed?.reason).toBe('forbidden');
    const again = join(people.vic);
    await until(() => again.denied !== undefined, 'vic’s rejoin to be refused');
    expect(again.denied).toBe('forbidden');
  });
});
