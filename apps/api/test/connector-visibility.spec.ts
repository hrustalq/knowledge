import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../src/permissions/permission.service.js';
import { AccessService } from '../src/auth/access.service.js';
import { ConnectorsService } from '../src/connectors/connectors.service.js';
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
