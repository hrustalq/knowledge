import type { INestApplication } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { vi } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { ArcadeClient } from '../src/graph/arcade.client.js';
import type { ProjectCascadeService } from '../src/projects/project-cascade.service.js';
import type { WorkspaceTeardownSweeper } from '../src/workspaces/workspace-teardown.sweeper.js';
import type { WorkspaceTeardownService } from '../src/workspaces/workspace-teardown.service.js';
import { WORKSPACE_ROWS } from '../src/workspaces/workspace-teardown.inventory.js';
import { WORKSPACE_VERTEX_TYPES } from '../src/graph/graph.service.js';

/**
 * #479 acceptance, end to end against live infra (`make infra-up`, the
 * embeddings provider apps/api/.env names, and OpenSearch when that file sets
 * FULLTEXT_PROVIDER=opensearch): a workspace with a project, an indexed page,
 * a connector, a share link, a site and API keys is deleted, is gone at once,
 * survives an interrupted teardown, and leaves no row, object or vertex.
 *
 * Runs as `AUTH_MODE=api-key` with its own non-platform-admin people: the dev
 * principal and a platform admin both pass every check for the wrong reason.
 */

const INDEX_TIMEOUT_MS = 120_000;

type Person = { id: string; key: string };

describe('workspace deletion (e2e, #479)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let arcade: ArcadeClient;
  let cascade: ProjectCascadeService;
  let teardown: WorkspaceTeardownService;
  let sweeper: WorkspaceTeardownSweeper;
  const nonce = randomUUID().slice(0, 8);
  const workspaceId = randomUUID();
  const name = `Doomed ${nonce}`;
  let admin: Person;
  let viewer: Person;
  let narrowKey: string;
  let shareToken: string;
  let slug: string;

  const http = () => request(app.getHttpServer());
  const as = (p: Person | string) => ({ Authorization: `Bearer ${typeof p === 'string' ? p : p.key}` });
  const ok = (code: number) => (res: request.Response) => {
    if (res.status !== code) throw new Error(`${res.status} (wanted ${code}): ${JSON.stringify(res.body)}`);
  };

  async function mintKey(userId: string, narrowTo?: string): Promise<string> {
    const key = `kn_${randomBytes(24).toString('hex')}`;
    await prisma.apiKey.create({
      data: {
        userId,
        name: `delete e2e ${nonce}`,
        keyHash: createHash('sha256').update(key).digest('hex'),
        prefix: key.slice(0, 11),
        scope: 'write',
        workspaceId: narrowTo ?? null,
      },
    });
    return key;
  }

  async function person(role: 'admin' | 'viewer'): Promise<Person> {
    const user = await prisma.user.create({
      data: { email: `ws-delete-${role}-${nonce}@example.test`, displayName: `Delete ${role}`, isAdmin: false, emailVerifiedAt: new Date() },
    });
    await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role } });
    return { id: user.id, key: await mintKey(user.id) };
  }

  async function vertices(): Promise<number> {
    let total = 0;
    for (const type of WORKSPACE_VERTEX_TYPES) {
      const [row] = await arcade.query<{ n?: number }>('sql', `SELECT count(*) AS n FROM ${type} WHERE workspaceId = :ws`, { ws: workspaceId });
      total += row?.n ?? 0;
    }
    return total;
  }

  async function objectsUnderPrefix(): Promise<number> {
    const config = app.get(ConfigService);
    const s3 = new S3Client({
      endpoint: config.get<string>('S3_ENDPOINT'),
      region: config.get<string>('S3_REGION'),
      forcePathStyle: true,
      credentials: { accessKeyId: config.get<string>('S3_ACCESS_KEY')!, secretAccessKey: config.get<string>('S3_SECRET_KEY')! },
    });
    const listed = await s3.send(
      new ListObjectVersionsCommand({ Bucket: config.get<string>('S3_BUCKET'), Prefix: `workspaces/${workspaceId}/` }),
    );
    return (listed.Versions?.length ?? 0) + (listed.DeleteMarkers?.length ?? 0);
  }

  beforeAll(async () => {
    process.env.AUTH_MODE = 'api-key';
    // After AUTH_MODE: ConfigModule validates the env once, at import time.
    const [e2e, ingestion, prismaMod, arcadeMod, cascadeMod, teardownMod, sweeperMod] = await Promise.all([
      import('./e2e-app.js'),
      import('../src/ingestion/ingestion-worker.module.js'),
      import('../src/prisma/prisma.service.js'),
      import('../src/graph/arcade.client.js'),
      import('../src/projects/project-cascade.service.js'),
      import('../src/workspaces/workspace-teardown.service.js'),
      import('../src/workspaces/workspace-teardown.sweeper.js'),
    ]);
    app = await e2e.createE2eApp([ingestion.IngestionWorkerModule]);
    prisma = app.get(prismaMod.PrismaService);
    arcade = app.get(arcadeMod.ArcadeClient);
    cascade = app.get(cascadeMod.ProjectCascadeService);
    teardown = app.get(teardownMod.WorkspaceTeardownService);
    sweeper = app.get(sweeperMod.WorkspaceTeardownSweeper);

    await prisma.workspace.create({ data: { id: workspaceId, name } });
    admin = await person('admin');
    viewer = await person('viewer');
    narrowKey = await mintKey(admin.id, workspaceId);

    const project = await http().post('/v1/projects').set(as(admin)).send({ workspaceId, name: `P ${nonce}` }).expect(ok(201));
    const projectId = project.body.project.projectId as string;
    const page = await http()
      .post('/v1/documents')
      .set(as(admin))
      .send({
        workspaceId,
        projectId,
        title: `Teardown runbook ${nonce}`,
        content: { mode: 'inline', format: 'markdown', text: `# Teardown runbook ${nonce}\n\nDepends on [[service:billing-${nonce}]].\n` },
      })
      .expect(ok(201));
    const deadline = Date.now() + INDEX_TIMEOUT_MS;
    for (;;) {
      const rev = await prisma.documentRevision.findUniqueOrThrow({ where: { id: page.body.revisionId }, select: { status: true } });
      if (rev.status === 'indexed') break;
      if (rev.status === 'failed' || Date.now() > deadline) throw new Error(`page did not index (${rev.status})`);
      await new Promise((r) => setTimeout(r, 500));
    }

    await prisma.connector.create({ data: { workspaceId, projectId, kind: 'github', name: `C ${nonce}` } });
    await prisma.publishingSettings.create({ data: { workspaceId, allowShareLinks: true, allowPasswordlessShares: true, allowPublicSites: true } });
    const share = await http().post(`/v1/documents/${page.body.documentId}/shares`).set(as(admin)).send({}).expect(ok(201));
    shareToken = (share.body.url as string).split('/').pop()!;
    slug = `doomed-${nonce}`;
    await prisma.publishedSite.create({ data: { workspaceId, projectId, slug, status: 'live', createdBy: admin.id } });
  }, INDEX_TIMEOUT_MS + 30_000);

  afterAll(async () => {
    // A run that failed early still tears its workspace down, with the code under test.
    await prisma?.workspace.updateMany({ where: { id: workspaceId, deletedAt: null }, data: { deletedAt: new Date() } });
    await sweeper?.sweep();
    await prisma?.user.deleteMany({ where: { email: { contains: `-${nonce}@example.test` } } });
    await app?.close();
  });

  it('starts out whole: the share link resolves and the vertices exist', async () => {
    await http().get(`/v1/public/shares/${shareToken}`).expect(ok(200));
    expect(await vertices()).toBeGreaterThan(0);
    expect(await objectsUnderPrefix()).toBeGreaterThan(0);
  });

  it('refuses a non-admin with 403 and a wrong confirmation with 400, deleting nothing', async () => {
    await http().delete(`/v1/workspaces/${workspaceId}`).query({ confirm: name }).set(as(viewer)).expect(ok(403));
    await http().get(`/v1/workspaces/${workspaceId}/deletion-preview`).set(as(viewer)).expect(ok(403));
    await http().delete(`/v1/workspaces/${workspaceId}`).query({ confirm: name.toUpperCase() }).set(as(admin)).expect(ok(400));
    await http().delete(`/v1/workspaces/${workspaceId}`).set(as(admin)).expect(ok(400));
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).deletedAt).toBeNull();
  });

  it('previews counted holdings', async () => {
    const res = await http().get(`/v1/workspaces/${workspaceId}/deletion-preview`).set(as(admin)).expect(ok(200));
    expect(res.body.counts).toMatchObject({ projects: 1, documents: 1, revisions: 1, storedFiles: 2, connectors: 1, publishedSites: 1 });
  });

  it('is gone to every caller from the tombstone on, before the sweep runs', async () => {
    // Hold the teardown so the window between tombstone and sweep stays open.
    const hold = vi.spyOn(teardown, 'teardown').mockResolvedValue(false);

    const res = await http().delete(`/v1/workspaces/${workspaceId}`).query({ confirm: name }).set(as(admin)).expect(ok(200));
    expect(res.body.counts.documents).toBe(1);

    const list = await http().get('/v1/workspaces').set(as(admin)).expect(ok(200));
    expect(list.body.workspaces.map((w: { workspaceId: string }) => w.workspaceId)).not.toContain(workspaceId);
    const me = await http().get('/v1/me').set(as(admin)).expect(ok(200));
    expect(me.body.memberships.map((m: { workspaceId: string }) => m.workspaceId)).not.toContain(workspaceId);
    await http().get(`/v1/workspaces/${workspaceId}/members`).set(as(admin)).expect(ok(404));
    await http().get('/v1/projects').query({ workspaceId }).set(as(admin)).expect(ok(404));
    // A route that resolves its workspace off a child row, not the :id.
    const doc = await prisma.document.findFirstOrThrow({ where: { workspaceId } });
    await http().get(`/v1/documents/${doc.id}`).set(as(admin)).expect(ok(404));

    await http().get(`/v1/public/shares/${shareToken}`).expect(ok(404));
    await http().get('/v1/public/sites/resolve').query({ slug, path: '/' }).expect(ok(404));
    await http().get('/v1/workspaces').set(as(narrowKey)).expect(ok(401));
    hold.mockRestore();
  });

  it('resumes an interrupted teardown on the next tick', async () => {
    const original = cascade.cascadeDocuments.bind(cascade);
    // The first batch commits, then the process "dies".
    const crash = vi.spyOn(cascade, 'cascadeDocuments').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error('killed mid-teardown');
    });
    await sweeper.sweep();
    expect(crash).toHaveBeenCalled();
    crash.mockRestore();
    expect(await prisma.workspace.count({ where: { id: workspaceId } })).toBe(1);
    expect(await prisma.document.count({ where: { workspaceId } })).toBe(0);

    expect(await sweeper.sweep()).toBeGreaterThanOrEqual(1);
    expect(await prisma.workspace.count({ where: { id: workspaceId } })).toBe(0);
  });

  it('leaves no row, object or vertex behind, and keeps the audit record', async () => {
    const leftovers: string[] = [];
    for (const model of WORKSPACE_ROWS) {
      const delegate = (prisma as unknown as Record<string, { count(a: unknown): Promise<number> }>)[model.charAt(0).toLowerCase() + model.slice(1)];
      if (await delegate.count({ where: { workspaceId } })) leftovers.push(model);
    }
    expect(leftovers).toEqual([]);
    expect(await prisma.document.count({ where: { workspaceId } })).toBe(0);
    expect(await objectsUnderPrefix()).toBe(0);
    expect(await vertices()).toBe(0);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { workspaceId, action: 'workspace.deleted' } });
    expect(audit.actor).toBe(admin.id);
    expect(audit.params).toMatchObject({ name, documents: 1 });

    await http().get(`/v1/public/shares/${shareToken}`).expect(ok(404));
    await http().get('/v1/workspaces').set(as(narrowKey)).expect(ok(401));
    await http().get(`/v1/workspaces/${workspaceId}/members`).set(as(admin)).expect(ok(404));
  });
});
