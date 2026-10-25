import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Connector } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #76 acceptance, end to end against live infra: page restrictions hold for
 * real users, with real API keys, across REST, search (all three modes), the
 * activity feed and MCP, and for a page a connector mirrored. #474: a page a
 * person creates is a private draft until they publish it.
 *
 * Unlike the other e2e specs this one cannot run as the `AUTH_MODE=none` dev
 * principal, which bypasses every restriction. It forces `AUTH_MODE=api-key`
 * and creates its own people in a fixed workspace of their own:
 *
 *   admin — workspace admin, NOT a platform admin (`make auth-bootstrap` makes
 *           one, and a platform admin passes every check for the wrong reason)
 *   alice — editor, member of the restricted group
 *   bob   — editor, not in the group
 *   gus   — guest
 *
 * Needs `make infra-up`, the embeddings provider apps/api/.env names and, when
 * that file sets FULLTEXT_PROVIDER=opensearch, `make infra-up-opensearch`.
 * Each run makes a fresh project and archives its pages at the end; the API
 * keys it mints are deleted.
 */

const WORKSPACE = '76000000-0000-4076-8076-000000000076';
const INDEX_TIMEOUT_MS = 120_000;
const RESTAMP_TIMEOUT_MS = 30_000;

type Role = 'admin' | 'editor' | 'guest';
type Person = { id: string; email: string; key: string; keyId: string };
type Hit = { documentId: string };

/** Same probe as verification.e2e-spec.ts: name the missing dependency before a write fails as `fetch failed`. */
async function assertReachable(config: ConfigService): Promise<void> {
  const probes: Array<{ what: string; url: string }> = [];
  if (config.get<string>('EMBEDDINGS_PROVIDER') === 'openai-compatible') {
    probes.push({ what: 'embeddings', url: `${(config.get<string>('EMBEDDINGS_BASE_URL') ?? '').replace(/\/+$/, '')}/models` });
  }
  if (config.get<string>('FULLTEXT_PROVIDER') === 'opensearch') {
    probes.push({ what: 'OpenSearch (`make infra-up-opensearch`)', url: config.get<string>('OPENSEARCH_URL') ?? '' });
  }
  const down: string[] = [];
  for (const p of probes) {
    try {
      await fetch(p.url, { signal: AbortSignal.timeout(3_000) });
    } catch {
      down.push(`${p.what} at ${p.url} is unreachable`);
    }
  }
  if (down.length) throw new Error(`e2e prerequisites missing:\n  ${down.join('\n  ')}`);
}

describe('page permissions (e2e, #76)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fulltext = false;
  const nonce = randomUUID().slice(0, 8);
  const word = `zorbex${nonce}`;
  const people = {} as Record<'admin' | 'alice' | 'bob' | 'gus', Person>;
  let projectId: string;
  let groupId: string;
  let connector: Connector | null = null;

  /** Title by page; P and C are the restricted subtree, O and S the open one, M the connector's. */
  const titles = {
    O: `Open handbook ${word}`,
    S: `Guest brief ${word}`,
    P: `Payroll ledger ${word}`,
    C: `Payroll bonuses ${word}`,
    M: `Mirrored runbook ${word}`,
  };
  const ids = {} as Record<keyof typeof titles, string>;

  const http = () => request(app.getHttpServer());
  /** `.expect(code)` that says why: a setup step failing on a bare "got 400" is a guessing game. */
  const ok = (code: number) => (res: request.Response) => {
    if (res.status !== code) throw new Error(`${res.status} (wanted ${code}): ${JSON.stringify(res.body)}`);
  };
  const as = (p: Person) => ({ Authorization: `Bearer ${p.key}` });

  async function person(name: string, role: Role): Promise<Person> {
    const email = `acl-e2e-${name}@example.test`;
    const user = await prisma.user.upsert({
      where: { email },
      update: { isAdmin: false, emailVerifiedAt: new Date() },
      create: { email, displayName: `ACL ${name}`, isAdmin: false, emailVerifiedAt: new Date() },
    });
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: WORKSPACE, userId: user.id } },
      update: { role },
      create: { workspaceId: WORKSPACE, userId: user.id, role },
    });
    const key = `kn_${randomBytes(24).toString('hex')}`;
    const row = await prisma.apiKey.create({
      data: {
        userId: user.id,
        name: `acl e2e ${nonce}`,
        keyHash: createHash('sha256').update(key).digest('hex'),
        prefix: key.slice(0, 11),
        scope: 'write',
      },
    });
    return { id: user.id, email, key, keyId: row.id };
  }

  async function createPage(key: keyof typeof titles, parentId?: string): Promise<string> {
    const res = await http()
      .post('/v1/documents')
      .set(as(people.admin))
      .send({
        workspaceId: WORKSPACE,
        projectId,
        title: titles[key],
        // These pages exist to be restricted by hand; a private draft is #474's own block below.
        visibility: 'workspace',
        ...(parentId ? { parentId } : {}),
        content: {
          mode: 'inline',
          format: 'markdown',
          text: `# ${titles[key]}\n\nThe ${word} procedure for ${key}: who signs it, where the record lives, and when it is reviewed.\n`,
        },
      })
      .expect(ok(201));
    ids[key] = res.body.documentId;
    return res.body.revisionId as string;
  }

  async function waitIndexed(revisionId: string): Promise<void> {
    const deadline = Date.now() + INDEX_TIMEOUT_MS;
    for (;;) {
      const rev = await prisma.documentRevision.findUniqueOrThrow({ where: { id: revisionId }, select: { status: true } });
      if (rev.status === 'indexed') return;
      if (rev.status === 'failed') throw new Error(`revision ${revisionId} failed to index`);
      if (Date.now() > deadline) throw new Error(`revision ${revisionId} still ${rev.status} after ${INDEX_TIMEOUT_MS}ms`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async function restrict(id: string, grants: Array<{ subjectType: 'user' | 'group'; subjectId: string; level: string }>) {
    await http().put(`/v1/documents/${id}/access`).set(as(people.admin)).send({ restricted: true, grants }).expect(ok(200));
  }

  async function search(p: Person, mode: 'semantic' | 'keyword' | 'hybrid', limit = 20): Promise<string[]> {
    const res = await http()
      .post('/v1/search')
      .set(as(p))
      .send({ workspaceId: WORKSPACE, query: `payroll ledger bonuses ${word}`, mode, limit, filters: { projectIds: [projectId] } })
      .expect(ok(200));
    return (res.body.results as Hit[]).map((h) => h.documentId);
  }

  async function treeIds(p: Person): Promise<string[]> {
    const res = await http().get('/v1/documents/tree').query({ workspaceId: WORKSPACE, projectId }).set(as(p)).expect(ok(200));
    const out: string[] = [];
    const walk = (nodes: Array<{ documentId: string; children: unknown[] }>) =>
      nodes.forEach((n) => (out.push(n.documentId), walk(n.children as never)));
    walk(res.body.roots);
    return out;
  }

  async function mcp(p: Person, name: string, args: Record<string, unknown>) {
    const res = await http()
      .post('/v1/mcp')
      .set({ ...as(p), Accept: 'application/json, text/event-stream' })
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      .expect(ok(200));
    return res.body.result as { isError?: boolean; content: Array<{ text: string }> };
  }

  const status = (p: Person, path: string) =>
    http()
      .get(path)
      .set(as(p))
      .then((r) => r.status);

  beforeAll(async () => {
    // Before the app module is imported: ConfigModule validates the env once,
    // at import time, and the dev principal would bypass everything here.
    process.env.AUTH_MODE = 'api-key';
    process.env.ACL_RESTAMP_TICK_MS = '1000';
    const [{ createE2eApp }, { IngestionWorkerModule }, { AclWorkerModule }, { PrismaService }, { ConfigService }] =
      await Promise.all([
        import('./e2e-app.js'),
        import('../src/ingestion/ingestion-worker.module.js'),
        import('../src/permissions/acl-worker.module.js'),
        import('../src/prisma/prisma.service.js'),
        import('@nestjs/config'),
      ]);
    // In-process consumers, so neither indexing nor the re-stamp depends on
    // whether `make dev`'s worker is running (or running older code).
    app = await createE2eApp([IngestionWorkerModule, AclWorkerModule]);
    prisma = app.get(PrismaService);
    const config = app.get(ConfigService);
    await assertReachable(config);
    fulltext = config.get<string>('FULLTEXT_PROVIDER') === 'opensearch';

    await prisma.workspace.upsert({
      where: { id: WORKSPACE },
      update: {},
      create: { id: WORKSPACE, name: 'ACL e2e (#76)' },
    });
    people.admin = await person('admin', 'admin');
    people.alice = await person('alice', 'editor');
    people.bob = await person('bob', 'editor');
    people.gus = await person('gus', 'guest');
    projectId = (await prisma.project.create({ data: { workspaceId: WORKSPACE, name: `ACL e2e ${nonce}` } })).id;

    const group = await http()
      .post('/v1/groups')
      .set(as(people.admin))
      .send({ workspaceId: WORKSPACE, name: `Payroll ${nonce}` })
      .expect(ok(201));
    groupId = group.body.groupId;
    await http().put(`/v1/groups/${groupId}/members`).set(as(people.admin)).send({ add: [people.alice.id] }).expect(ok(200));

    const revisions = [await createPage('O'), await createPage('P'), await createPage('M')];
    revisions.push(await createPage('S', ids.O), await createPage('C', ids.P));
    await Promise.all(revisions.map(waitIndexed));

    await restrict(ids.P, [{ subjectType: 'group', subjectId: groupId, level: 'view' }]);
    await restrict(ids.S, [
      { subjectType: 'user', subjectId: people.gus.id, level: 'view' },
      { subjectType: 'user', subjectId: people.alice.id, level: 'view' },
      { subjectType: 'user', subjectId: people.bob.id, level: 'view' },
    ]);
  }, INDEX_TIMEOUT_MS + 60_000);

  afterAll(async () => {
    if (!app) return;
    if (connector) await http().delete(`/v1/connectors/${connector.id}`).set(as(people.admin));
    for (const id of Object.values(ids)) await http().post(`/v1/documents/${id}/archive`).set(as(people.admin)).send({});
    const keyIds = Object.values(people).map((p) => p.keyId);
    if (keyIds.length) await prisma.apiKey.deleteMany({ where: { id: { in: keyIds } } });
    await app.close();
  });

  describe('groups and guests', () => {
    it('a non-admin cannot create a group', async () => {
      await http().post('/v1/groups').set(as(people.bob)).send({ workspaceId: WORKSPACE, name: `Nope ${nonce}` }).expect(ok(403));
    });

    it('a guest sees only the page granted to them, and 404s on everything else', async () => {
      expect(await treeIds(people.gus)).toEqual([ids.S]);
      expect(await status(people.gus, `/v1/documents/${ids.S}`)).toBe(200);
      for (const id of [ids.O, ids.P, ids.C, ids.M]) expect(await status(people.gus, `/v1/documents/${id}`)).toBe(404);
    });

    it('a guest is refused workspace-level routes', async () => {
      expect(await status(people.gus, `/v1/groups?workspaceId=${WORKSPACE}`)).toBe(403);
    });

    it("a guest's breadcrumb names no ancestor it cannot open", async () => {
      const res = await http().get(`/v1/documents/${ids.S}/ancestors`).set(as(people.gus)).expect(ok(200));
      // As built: the placeholder keeps its id and drops everything else.
      expect(res.body.ancestors).toEqual([expect.objectContaining({ documentId: ids.O, title: '', hidden: true })]);
      expect(JSON.stringify(res.body)).not.toContain(titles.O);
    });
  });

  describe('restrictions and inheritance', () => {
    it('hides the restricted page and its subtree from the list and the tree', async () => {
      const list = await http().get('/v1/documents').query({ workspaceId: WORKSPACE, projectId, limit: 100 }).set(as(people.bob));
      const listed = list.body.items.map((d: { documentId: string }) => d.documentId);
      expect(listed).toEqual(expect.arrayContaining([ids.O, ids.S, ids.M]));
      expect(listed).not.toContain(ids.P);
      expect(listed).not.toContain(ids.C);

      const bobTree = await treeIds(people.bob);
      expect(bobTree).not.toContain(ids.P);
      expect(bobTree).not.toContain(ids.C);
      expect(await treeIds(people.alice)).toEqual(expect.arrayContaining([ids.P, ids.C]));
    });

    it('answers a member 403 with canRequestAccess and no title, on every per-page route', async () => {
      for (const id of [ids.P, ids.C]) {
        for (const suffix of ['', '/content', '/revisions', '/threads', '/relations', '/ancestors', '/graph']) {
          const res = await http().get(`/v1/documents/${id}${suffix}`).set(as(people.bob));
          expect([suffix, res.status]).toEqual([suffix, 403]);
          expect(res.body.details).toMatchObject({ canRequestAccess: true, resourceType: 'document', resourceId: id });
          expect(JSON.stringify(res.body)).not.toContain(word);
        }
      }
    });

    it('lets a group member open the subtree', async () => {
      expect(await status(people.alice, `/v1/documents/${ids.P}`)).toBe(200);
      expect(await status(people.alice, `/v1/documents/${ids.C}/content`)).toBe(200);
    });

    it('restricts a page moved under a restricted parent at once, and lifts it when moved out', async () => {
      await http().post(`/v1/documents/${ids.O}/move`).set(as(people.admin)).send({ parentId: ids.P }).expect(ok(201));
      expect(await status(people.bob, `/v1/documents/${ids.O}`)).toBe(403);
      expect(await status(people.bob, `/v1/documents/${ids.S}`)).toBe(403);
      await http().post(`/v1/documents/${ids.O}/move`).set(as(people.admin)).send({ parentId: null }).expect(ok(201));
      expect(await status(people.bob, `/v1/documents/${ids.O}`)).toBe(200);
      expect(await status(people.bob, `/v1/documents/${ids.S}`)).toBe(200);
    });

    it("audits a workspace admin's read of a page no grant admits them to", async () => {
      expect(await status(people.admin, `/v1/documents/${ids.C}`)).toBe(200);
      const deadline = Date.now() + 5_000;
      for (;;) {
        const row = await prisma.auditLog.findFirst({
          where: { workspaceId: WORKSPACE, actor: people.admin.id, action: 'acl.bypass', params: { path: ['resourceId'], equals: ids.C } },
        });
        if (row) break;
        if (Date.now() > deadline) throw new Error('no acl.bypass audit row for the admin read');
        await new Promise((r) => setTimeout(r, 200));
      }
    });
  });

  describe('retrieval', () => {
    it('search never returns a restricted page, in any mode, and still fills the limit', async () => {
      const modes = fulltext ? (['semantic', 'keyword', 'hybrid'] as const) : (['semantic', 'hybrid'] as const);
      for (const mode of modes) {
        const bob = await search(people.bob, mode);
        expect([mode, bob.includes(ids.P) || bob.includes(ids.C)]).toEqual([mode, false]);
        expect([mode, await search(people.alice, mode)]).toEqual([mode, expect.arrayContaining([ids.P, ids.C])]);
      }
      // P and C rank first for this query; two visible pages still come back.
      expect(await search(people.bob, 'semantic', 2)).toHaveLength(2);
    });

    it('stamps the restriction onto the search stores within a sweeper tick', async () => {
      const deadline = Date.now() + RESTAMP_TIMEOUT_MS;
      for (;;) {
        const rows = await prisma.document.findMany({
          where: { id: { in: [ids.P, ids.C, ids.S] } },
          select: { aclVersion: true, aclStampedVersion: true },
        });
        if (rows.every((r) => r.aclVersion > 0 && r.aclStampedVersion === r.aclVersion)) break;
        if (Date.now() > deadline) throw new Error(`stamps did not converge: ${JSON.stringify(rows)}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }, RESTAMP_TIMEOUT_MS + 5_000);

    it('the activity feed leaves out entries about pages the caller cannot open', async () => {
      const feed = async (p: Person) =>
        (await http().get('/v1/activity').query({ workspaceId: WORKSPACE, projectId, limit: 100 }).set(as(p)).expect(ok(200))).body;
      const bob = await feed(people.bob);
      const seen = new Set(bob.entries.map((e: { documentId: string | null }) => e.documentId));
      expect(seen.has(ids.O)).toBe(true);
      expect(seen.has(ids.P) || seen.has(ids.C)).toBe(false);
      expect(JSON.stringify(bob)).not.toContain('Payroll');
      const alice = await feed(people.alice);
      expect(alice.entries.some((e: { documentId: string | null }) => e.documentId === ids.P)).toBe(true);
    });

    it('MCP search and reads honour the restriction for a scoped key', async () => {
      const results = async (p: Person) => {
        const res = await mcp(p, 'knowledge_search', { workspaceId: WORKSPACE, query: `payroll ${word}`, projectIds: [projectId] });
        return (JSON.parse(res.content[0].text).results as Hit[]).map((h) => h.documentId);
      };
      const bob = await results(people.bob);
      expect(bob.includes(ids.P) || bob.includes(ids.C)).toBe(false);
      expect(await results(people.alice)).toEqual(expect.arrayContaining([ids.P]));

      const read = await mcp(people.bob, 'knowledge_get_document', { documentId: ids.P });
      expect(read.isError).toBe(true);
      expect(JSON.stringify(read)).not.toContain(word);
    });
  });

  describe('connector mirroring', () => {
    // No vendor: a stand-in adapter answers the two ACL calls, and the real
    // ConnectorAclService captures, maps and applies what it says.
    const restrictedTo = (group: string) => ({
      audience: 'restricted' as const,
      principals: [{ type: 'group' as const, externalId: group, name: 'finance', level: 'view' as const }],
    });
    let upstream: { audience: 'restricted' | 'source-wide'; principals: unknown[] };

    async function sync() {
      const { ConnectorAclService } = await import('../src/connectors/connector-acl.service.js');
      const acl = app.get(ConnectorAclService, { strict: false });
      const adapter = {
        permissions: async () => upstream,
        groupMembers: async () => [{ externalId: 'u-alice', email: people.alice.email }],
      };
      const ctx = { connectorId: connector!.id, workspaceId: WORKSPACE, debug: () => undefined };
      const stored = await acl.capture(connector!, adapter as never, ctx as never, { externalId: 'page-m' } as never);
      const link = await prisma.connectorLink.findFirstOrThrow({ where: { connectorId: connector!.id, documentId: ids.M } });
      return acl.applyToPage(connector!, link, stored);
    }

    beforeAll(async () => {
      connector = await prisma.connector.create({
        data: {
          workspaceId: WORKSPACE,
          kind: 'confluence',
          name: `ACL e2e ${nonce}`,
          projectId,
          aclMode: 'mirror',
          createdBy: people.admin.id,
        },
      });
      await prisma.connectorLink.create({
        data: { connectorId: connector.id, workspaceId: WORKSPACE, documentId: ids.M, externalId: 'page-m' },
      });
    });

    it('a source restricted to a group imports restricted to the mirrored group, mapped by verified email', async () => {
      upstream = restrictedTo('grp-finance');
      expect((await sync()).changed).toBe(true);
      expect(await status(people.alice, `/v1/documents/${ids.M}`)).toBe(200);
      expect(await status(people.bob, `/v1/documents/${ids.M}`)).toBe(403);
    });

    it('an upstream that opens up lifts the restriction without a content fetch', async () => {
      upstream = { audience: 'source-wide', principals: [] };
      expect((await sync()).changed).toBe(true);
      expect(await status(people.bob, `/v1/documents/${ids.M}`)).toBe(200);
    });

    it('a manual grant survives the next sync', async () => {
      upstream = restrictedTo('grp-finance');
      await sync();
      await restrict(ids.M, [{ subjectType: 'user', subjectId: people.bob.id, level: 'view' }]);
      expect(await status(people.bob, `/v1/documents/${ids.M}`)).toBe(200);

      upstream = { audience: 'source-wide', principals: [] };
      await sync();
      // Bob's grant is a person's, so the page stays restricted to him; the
      // connector's own grant to the group is gone with the upstream one.
      expect(await status(people.bob, `/v1/documents/${ids.M}`)).toBe(200);
      expect(await status(people.alice, `/v1/documents/${ids.M}`)).toBe(403);
    });
  });

  // #236, phase 3: a usage site's path is code and always listed; a page
  // documenting it is titled only for someone who may open it.
  describe('component usages', () => {
    let code: Connector;

    beforeAll(async () => {
      code = await prisma.connector.create({
        data: {
          workspaceId: WORKSPACE,
          projectId,
          kind: 'codebase',
          name: `Code ${nonce}`,
          config: { repoUrl: `https://github.com/acl-e2e/repo-${nonce}` },
        },
      });
      // O documents lib/money.ts; P (restricted to the group) documents its only importer.
      await prisma.codeImport.create({
        data: {
          connectorId: code.id,
          workspaceId: WORKSPACE,
          headSha: 'e2e',
          importerPath: 'app/payroll.ts',
          importedPath: 'lib/money.ts',
          names: ['Money'],
        },
      });
      const declare = (documentId: string, path: string) =>
        prisma.componentDeclaration.create({
          data: {
            documentId,
            workspaceId: WORKSPACE,
            revisionId: randomUUID(),
            componentKey: `component:${path}`,
            componentName: path,
            connectorId: code.id,
            paths: [path],
            symbols: [],
          },
        });
      await declare(ids.O, 'lib/money.ts');
      await declare(ids.P, 'app/payroll.ts');
    });

    afterAll(async () => {
      await prisma.componentDeclaration.deleteMany({ where: { documentId: { in: [ids.O, ids.P] } } });
      if (code) await prisma.connector.delete({ where: { id: code.id } });
    });

    const usagesAs = async (p: Person) =>
      (await http().get(`/v1/documents/${ids.O}/component/usages`).set(as(p)).expect(ok(200))).body;

    it('shows a non-admin outside the group the path and a count, never the title', async () => {
      const body = await usagesAs(people.bob);
      expect(body.usages).toEqual([
        { path: 'app/payroll.ts', imports: [{ path: 'lib/money.ts', names: ['Money'] }], pages: [], hiddenPages: 1 },
      ]);
      expect(JSON.stringify(body)).not.toContain(titles.P);
    });

    it('titles the page for a group member', async () => {
      const body = await usagesAs(people.alice);
      expect(body.usages[0]).toMatchObject({ pages: [{ id: ids.P, title: titles.P }], hiddenPages: 0 });
    });

    it('answers the same over MCP, by page and by path', async () => {
      const rest = await usagesAs(people.bob);
      const byPage = await mcp(people.bob, 'knowledge_code_usages', { documentId: ids.O });
      const byPath = await mcp(people.bob, 'knowledge_code_usages', { workspaceId: WORKSPACE, path: 'lib/money.ts' });
      expect(JSON.parse(byPage.content[0].text).usages).toEqual(rest.usages);
      expect(JSON.parse(byPath.content[0].text).usages).toEqual(rest.usages);
      expect(byPath.content[0].text).not.toContain(titles.P);
    });

    it('is a 404 for a guest, like the page itself', async () => {
      expect(await status(people.gus, `/v1/documents/${ids.O}/component/usages`)).toBe(404);
    });
  });

  describe('private drafts (#474)', () => {
    const draftTitle = `Draft memo ${word}`;
    const draftText = `# ${draftTitle}\n\nThe ${word} payroll ledger draft: what changes in the bonuses, and who signs it.\n`;
    const draft = {} as Record<'rest' | 'mcp' | 'open' | 'nested' | 'system', string>;

    const createAs = (p: Person, body: Record<string, unknown>) =>
      http()
        .post('/v1/documents')
        .set(as(p))
        .send({ workspaceId: WORKSPACE, projectId, ...body })
        .expect(ok(201))
        .then((r) => r.body as { documentId: string; revisionId: string });
    const share = (grants: Array<{ subjectType: 'user'; subjectId: string; level: string }>) =>
      http()
        .put(`/v1/documents/${draft.rest}/access`)
        .set(as(people.alice))
        .send({ restricted: true, grants: [{ subjectType: 'user', subjectId: people.alice.id, level: 'manage' }, ...grants] });
    const listIds = async (p: Person) =>
      (await http().get('/v1/documents').query({ workspaceId: WORKSPACE, projectId, limit: 100 }).set(as(p)).expect(ok(200))).body.items.map(
        (d: { documentId: string }) => d.documentId,
      );

    beforeAll(async () => {
      const rest = await createAs(people.alice, { title: draftTitle, content: { mode: 'inline', format: 'markdown', text: draftText } });
      draft.rest = rest.documentId;
      const viaMcp = await mcp(people.alice, 'knowledge_create_document', {
        workspaceId: WORKSPACE,
        projectId,
        title: `Agent notes ${word}`,
        content: `Notes for ${word}.`,
      });
      draft.mcp = JSON.parse(viaMcp.content[0].text).documentId;
      draft.open = (await createAs(people.alice, { title: `Open child ${word}`, parentId: draft.rest, visibility: 'workspace' })).documentId;
      draft.nested = (await createAs(people.alice, { title: `Private child ${word}`, parentId: draft.rest })).documentId;
      // What import, connector pulls and workflows call: no visibility, no person behind it.
      const { DocumentsService } = await import('../src/documents/documents.service.js');
      draft.system = (
        await app.get(DocumentsService, { strict: false }).createDocument({ workspaceId: WORKSPACE, projectId, title: `Imported ${word}` }, people.admin.id)
      ).documentId;
      await prisma.notificationSubscription.create({
        data: { workspaceId: WORKSPACE, userId: people.bob.id, subjectType: 'project', subjectId: projectId },
      });
      await waitIndexed(rest.revisionId);
    }, INDEX_TIMEOUT_MS + 10_000);

    afterAll(async () => {
      for (const id of Object.values(draft)) await http().post(`/v1/documents/${id}/archive`).set(as(people.admin)).send({});
    });

    it('a page created over REST or MCP is hidden from a second editor everywhere, and a 403 with no title by id', async () => {
      const tree = await treeIds(people.bob);
      const list = await listIds(people.bob);
      for (const id of [draft.rest, draft.mcp, draft.open, draft.nested]) {
        expect(tree).not.toContain(id);
        expect(list).not.toContain(id);
        const res = await http().get(`/v1/documents/${id}`).set(as(people.bob));
        expect(res.status).toBe(403);
        expect(res.body.details).toMatchObject({ canRequestAccess: true, resourceId: id });
        expect(JSON.stringify(res.body)).not.toContain(word);
      }
      expect(await status(people.gus, `/v1/documents/${draft.rest}`)).toBe(404);
      expect(await search(people.bob, 'semantic')).not.toContain(draft.rest);
      const feed = await http().get('/v1/activity').query({ workspaceId: WORKSPACE, projectId, limit: 100 }).set(as(people.bob)).expect(ok(200));
      expect(JSON.stringify(feed.body)).not.toContain(draft.rest);
      const viaMcp = await mcp(people.bob, 'knowledge_search', { workspaceId: WORKSPACE, query: `draft memo ${word}`, projectIds: [projectId] });
      expect(viaMcp.content[0].text).not.toContain(draft.rest);
    });

    it('its author sees it as a draft, and a system-created page is open to everyone at once', async () => {
      const res = await http().get(`/v1/documents/${draft.rest}`).set(as(people.alice)).expect(ok(200));
      expect(res.body.document).toMatchObject({ draftOwnerId: people.alice.id, restricted: true });
      expect(await search(people.alice, 'semantic')).toContain(draft.rest);
      expect(await status(people.bob, `/v1/documents/${draft.system}`)).toBe(200);
      expect(await treeIds(people.bob)).toContain(draft.system);
    });

    it('sharing it at view shows it to that editor, and revoking hides it again', async () => {
      await share([{ subjectType: 'user', subjectId: people.bob.id, level: 'view' }]).expect(ok(200));
      expect(await treeIds(people.bob)).toContain(draft.rest);
      expect(await status(people.bob, `/v1/documents/${draft.rest}`)).toBe(200);
      expect(await search(people.bob, 'semantic')).toContain(draft.rest);
      await share([]).expect(ok(200));
      expect(await treeIds(people.bob)).not.toContain(draft.rest);
      expect(await status(people.bob, `/v1/documents/${draft.rest}`)).toBe(403);
    });

    it('cannot be unrestricted from the access dialog; only publish opens it', async () => {
      const res = await http()
        .put(`/v1/documents/${draft.rest}/access`)
        .set(as(people.alice))
        .send({ restricted: false, grants: [] });
      expect(res.status).toBe(409);
      expect(res.body.details).toMatchObject({ reason: 'access.draftPublishFirst' });
      await http().post(`/v1/documents/${draft.rest}/publish`).set(as(people.bob)).expect(ok(403));
    });

    it("a workspace admin opens it, and the read is audited", async () => {
      expect(await status(people.admin, `/v1/documents/${draft.mcp}`)).toBe(200);
      const deadline = Date.now() + 5_000;
      while (
        !(await prisma.auditLog.findFirst({
          where: { workspaceId: WORKSPACE, actor: people.admin.id, action: 'acl.bypass', params: { path: ['resourceId'], equals: draft.mcp } },
        }))
      ) {
        if (Date.now() > deadline) throw new Error('no acl.bypass audit row for the admin read of a draft');
        await new Promise((r) => setTimeout(r, 200));
      }
    });

    it('publish opens it to every member, tells watchers once, and leaves a private child private', async () => {
      const res = await http().post(`/v1/documents/${draft.rest}/publish`).set(as(people.alice)).expect(ok(201));
      expect(res.body.document).toMatchObject({ draftOwnerId: null, restricted: false });
      await http().post(`/v1/documents/${draft.rest}/publish`).set(as(people.alice)).expect(ok(201));

      expect(await status(people.bob, `/v1/documents/${draft.rest}`)).toBe(200);
      expect(await status(people.bob, `/v1/documents/${draft.open}`)).toBe(200);
      expect(await status(people.bob, `/v1/documents/${draft.nested}`)).toBe(403);
      expect(await treeIds(people.bob)).toEqual(expect.arrayContaining([draft.rest, draft.open]));
      expect(await status(people.gus, `/v1/documents/${draft.rest}`)).toBe(404);

      const published = await prisma.notification.findMany({
        where: { userId: people.bob.id, type: 'document.published', documentId: draft.rest },
      });
      expect(published).toHaveLength(1);
    });
  });

  describe('access requests', () => {
    it('request → duplicate 409 → approve opens the subtree to the requester', async () => {
      const body = { workspaceId: WORKSPACE, resourceType: 'document', resourceId: ids.C, level: 'view' };
      const created = await http().post('/v1/access-requests').set(as(people.bob)).send(body).expect(ok(201));
      await http().post('/v1/access-requests').set(as(people.bob)).send(body).expect(ok(409));

      const inbox = await http()
        .get('/v1/access-requests')
        .query({ workspaceId: WORKSPACE, status: 'pending' })
        .set(as(people.admin))
        .expect(ok(200));
      expect(JSON.stringify(inbox.body)).toContain(created.body.requestId);

      await http().post(`/v1/access-requests/${created.body.requestId}/approve`).set(as(people.admin)).send({}).expect(ok(201));
      expect(await status(people.bob, `/v1/documents/${ids.C}`)).toBe(200);
    });
  });
});
