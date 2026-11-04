import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../src/permissions/permission.service.js';
import { AccessService } from '../src/auth/access.service.js';
import { NotFoundException } from '@nestjs/common';
import { ConnectorsService } from '../src/connectors/connectors.service.js';
import { ConnectorItemsService } from '../src/connectors/connector-items.service.js';
import { withVisibleWarnings } from '../src/connectors/run-visibility.js';
import type { Principal } from '../src/auth/principal.js';
import { noAuthPolicy } from './auth-policy-fakes.js';

/**
 * #555: the connector routes follow the connector's project visibility, as the
 * code and work-item tools do since #553. `pb` is a restricted project; `c2`
 * lives in it, `c1` in the open project `pa`.
 */
const WS = '11111111-1111-4111-8111-111111111111';
const projects: Record<string, { id: string; restricted: boolean }> = {
  pa: { id: 'pa', restricted: false },
  pb: { id: 'pb', restricted: true },
};
const at = { createdAt: new Date(0), updatedAt: new Date(0), lastSyncedAt: null };
const connectors = [
  { id: 'c1', workspaceId: WS, projectId: 'pa', kind: 'markdown', name: 'Open', enabled: true, ...at },
  { id: 'c2', workspaceId: WS, projectId: 'pb', kind: 'markdown', name: 'Secret', enabled: true, ...at },
];
const runs = [{ id: 'r2', workspaceId: WS, connectorId: 'c2' }];

const bob: Principal = {
  userId: 'u-bob',
  email: 'bob@x.test',
  displayName: 'Bob',
  avatarUrl: null,
  mode: 'session',
  isAdmin: false,
  locale: 'en',
};

/** PermissionService with Bob as a member in `role`, holding a grant on `pb` or not. */
function permissionsAs(role: string, grantedPb: boolean) {
  const prisma = {
    workspace: { findUnique: async () => ({ deletedAt: null }) },
    workspaceMember: { findUnique: vi.fn(async () => ({ role, trustedOperator: false })) },
    userGroupMember: { findMany: vi.fn(async () => []) },
    accessGrant: { findMany: vi.fn(async () => (grantedPb ? [{ resourceId: 'pb' }] : [])) },
    document: { findMany: vi.fn(async () => []) },
    project: { findMany: vi.fn(async () => [{ id: 'pb' }]) },
    connector: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = connectors.find((c) => c.id === where.id);
        return row ? { workspaceId: row.workspaceId, project: projects[row.projectId] } : null;
      }),
    },
    connectorRun: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const run = runs.find((r) => r.id === where.id);
        const row = run && connectors.find((c) => c.id === run.connectorId);
        return run && row ? { workspaceId: run.workspaceId, connector: { project: projects[row.projectId] } } : null;
      }),
    },
  };
  const service = new PermissionService(
    prisma as never,
    new AccessService(prisma as never, noAuthPolicy),
    { record: vi.fn(async () => undefined) } as never,
    { get: () => 5000 } as never,
  );
  return { service, prisma };
}

function connectorsService() {
  const prisma = {
    connector: {
      findMany: vi.fn(async () => connectors.map((c) => ({ ...c, project: projects[c.projectId] }))),
    },
    connectorLink: { count: vi.fn(async () => 0) },
    connectorRun: { findFirst: vi.fn(async () => null) },
  };
  return new ConnectorsService(
    prisma as never,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('connector visibility (#555)', () => {
  it('lists only the connectors in projects the caller can open', async () => {
    const list = connectorsService();
    const outsider = await permissionsAs('viewer', false).service.scopeFor(bob, WS);
    const insider = await permissionsAs('viewer', true).service.scopeFor(bob, WS);
    const admin = await permissionsAs('admin', false).service.scopeFor(bob, WS);

    expect((await list.list(outsider)).map((c) => c.id)).toEqual(['c1']);
    expect((await list.list(insider)).map((c) => c.id)).toEqual(['c1', 'c2']);
    expect((await list.list(admin)).map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('answers a hidden connector and its runs as not found, and lets a granted member through', async () => {
    const outsider = permissionsAs('viewer', false);
    await expect(outsider.service.requireConnectorVisible(bob, { connectorId: 'c2' })).rejects.toThrow(
      /error\.connector\.notFound/,
    );
    await expect(outsider.service.requireConnectorVisible(bob, { runId: 'r2' })).rejects.toThrow(
      /error\.connector\.runNotFound/,
    );
    await expect(outsider.service.requireConnectorVisible(bob, { connectorId: 'c1' })).resolves.toBeUndefined();
    // An open project needs no scope at all.
    expect(outsider.prisma.workspaceMember.findUnique).toHaveBeenCalledTimes(2);

    const insider = permissionsAs('viewer', true);
    await expect(insider.service.requireConnectorVisible(bob, { connectorId: 'c2' })).resolves.toBeUndefined();
    await expect(insider.service.requireConnectorVisible(bob, { runId: 'r2' })).resolves.toBeUndefined();

    const admin = permissionsAs('admin', false);
    await expect(admin.service.requireConnectorVisible(bob, { connectorId: 'c2' })).resolves.toBeUndefined();
  });

  it('is not the dev principal’s concern', async () => {
    const { service, prisma } = permissionsAs('viewer', false);
    await service.requireConnectorVisible({ ...bob, mode: 'dev' }, { connectorId: 'c2' });
    expect(prisma.connector.findUnique).not.toHaveBeenCalled();
  });
});

/** #767: a run item is read under the page it writes, not just the connector's project. */
describe('staged run items', () => {
  const page = { id: 'p1', projectId: 'pa', path: '/p1/', restrictedBy: ['p1'] };
  const item = (over: Record<string, unknown>) => ({
    id: 'i1',
    runId: 'r1',
    title: 'Secret plan',
    externalId: 'docs/secret-plan.md',
    externalUrl: 'https://x.test/secret-plan',
    documentId: 'p1',
    stagedKey: 'staged',
    incomingKey: null,
    action: 'update',
    status: 'staged',
    acl: null,
    draft: null,
    error: null,
    updatedAt: new Date(0),
    ...over,
  });
  const scope = (over: Record<string, unknown> = {}) =>
    ({ userId: 'u', role: 'viewer', bypass: false, guest: false, readOnly: false, groupIds: new Set(), workspaceId: WS, denied: new Set(['p1']), granted: new Set(), ...over }) as never;

  function service(rows: ReturnType<typeof item>[]) {
    const prisma = {
      document: { findMany: vi.fn(async () => [page]), findUnique: vi.fn(async () => null) },
      connectorRun: { findUnique: vi.fn(async () => ({ id: 'r1', warnings: null })) },
      connectorRunItem: { findMany: vi.fn(async () => rows), findUnique: vi.fn(async () => rows[0]) },
    };
    const refusal = new Error('refused');
    const permissions = { requireLevel: vi.fn(async () => { throw refusal; }) };
    const documents = { getContent: vi.fn(async () => ({ markdown: 'current text' })) };
    const storage = { getObjectText: vi.fn(async () => 'staged text') };
    const svc = new ConnectorItemsService(prisma as never, documents as never, storage as never, {} as never, {} as never, {} as never, permissions as never);
    return { svc, documents, storage, permissions, refusal };
  }

  it('refuses a page the caller cannot open, reading no text', async () => {
    const { svc, documents, storage, refusal } = service([item({})]);
    await expect(svc.getItem('r1', 'i1', scope())).rejects.toBe(refusal);
    expect(documents.getContent).not.toHaveBeenCalled();
    expect(storage.getObjectText).not.toHaveBeenCalled();
  });

  it('lists such an item with nothing of the page in it', async () => {
    const { svc } = service([item({})]);
    const { items } = await svc.listItems('r1', scope());
    expect(JSON.stringify(items)).not.toMatch(/secret/i);
    expect(items[0]).toMatchObject({ id: 'i1', status: 'staged', documentId: null });
  });

  it('shows the page to someone who can open it, and to an admin', async () => {
    for (const who of [scope({ denied: new Set() }), scope({ bypass: true })]) {
      const { svc } = service([item({})]);
      expect((await svc.getItem('r1', 'i1', who)).markdown).toBe('staged text');
      expect((await svc.listItems('r1', who)).items[0]).toMatchObject({ title: 'Secret plan', documentId: 'p1' });
    }
  });

  it('keeps a new page with a mirrored ACL from a viewer, not from who can approve it', async () => {
    const newPage = item({ documentId: null, action: 'create', acl: { kind: 'audience' } });
    const { svc } = service([newPage]);
    await expect(svc.getItem('r1', 'i1', scope())).rejects.toBeInstanceOf(NotFoundException);
    expect((await svc.listItems('r1', scope())).items[0].title).not.toMatch(/secret/i);
    expect((await svc.getItem('r1', 'i1', scope({ role: 'editor' }))).markdown).toBe('staged text');
    const open = service([item({ documentId: null, action: 'create' })]);
    expect((await open.svc.getItem('r1', 'i1', scope())).markdown).toBe('staged text');
  });

  it('leaves out a warning naming such an item, and keeps the rest (#767)', async () => {
    const prisma = {
      document: { findMany: vi.fn(async () => [page]) },
      connectorRunItem: { findMany: vi.fn(async () => [{ id: 'i1', runId: 'r1', externalId: 'docs/secret-plan.md', documentId: 'p1', acl: null }]) },
    };
    const warnings = [
      { externalId: 'docs/secret-plan.md', title: 'Secret plan', message: 'Secret plan failed' },
      { externalId: null, title: null, message: 'Stopped after 10 items' },
    ];
    const run = { id: 'r1', warnings } as never;
    const [hidden] = await withVisibleWarnings(prisma as never, scope(), [run]);
    expect(JSON.stringify(hidden)).not.toMatch(/secret/i);
    expect((hidden as { warnings: unknown[] }).warnings).toHaveLength(1);
    const [open] = await withVisibleWarnings(prisma as never, scope({ denied: new Set() }), [run]);
    expect((open as { warnings: unknown[] }).warnings).toHaveLength(2);
    expect(await withVisibleWarnings(prisma as never, scope(), [null])).toEqual([null]);
  });
});
