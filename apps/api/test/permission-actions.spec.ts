import { describe, expect, it, vi } from 'vitest';
import {
  accessRank,
  MEMBER_CAPABILITIES,
  PERMISSION_ACTIONS,
  WORKSPACE_ACTIONS,
  type AccessLevel,
  type MemberCapability,
  type ResourceAction,
  type WorkspaceAction,
  type WorkspaceRole,
} from '@knowledge/contracts';
import { ACCESS_META, PLATFORM_ADMIN_META, type AccessSpec } from '../src/auth/access.decorator.js';
import { CACHE_POLICY_META } from '../src/common/http-cache.js';
import { AccessService } from '../src/auth/access.service.js';
import { AclGuard } from '../src/auth/acl.guard.js';
import type { Principal } from '../src/auth/principal.js';
import { workspaceCreationRefusal } from '../src/auth/workspace-creation.js';
import { PermissionService } from '../src/permissions/permission.service.js';
import { PermissionsResolver } from '../src/permissions/permissions.resolver.js';
import { ApiSpecsController, ProjectApiSettingsController } from '../src/api-specs/api-specs.controller.js';
import { MergeRequestsController } from '../src/documents/merge-requests.controller.js';
import { AccessController } from '../src/permissions/access.controller.js';
import { DocumentsController } from '../src/documents/documents.controller.js';
import { GlossaryController } from '../src/glossary/glossary.controller.js';
import { ProjectsController } from '../src/projects/projects.controller.js';
import { SearchController } from '../src/search/search.controller.js';
import { WorkspacesController } from '../src/workspaces/workspaces.controller.js';
import { noAuthPolicy } from './auth-policy-fakes.js';

/**
 * The permission catalogue (#1296): what `GET /v1/me/permissions` answers must
 * be what the matching route allows, so each action is held to one route here
 * and a rule changed on one side alone fails.
 */
const WS = '11111111-1111-4111-8111-111111111111';

describe('the catalogue', () => {
  it('every key is resource:action, and every capability is a member capability', () => {
    for (const [action, rule] of Object.entries(PERMISSION_ACTIONS)) {
      expect(action).toMatch(/^[a-z][a-z-]*:[a-z][a-z-]*$/);
      if ('capability' in rule) expect(MEMBER_CAPABILITIES).toContain(rule.capability);
    }
  });

  it('each member capability is the action of the same name (the web\'s `can()` maps one to the other)', () => {
    for (const capability of MEMBER_CAPABILITIES) {
      expect(PERMISSION_ACTIONS[capability.replace('.', ':') as keyof typeof PERMISSION_ACTIONS]).toMatchObject({ capability });
    }
  });

  it('an action is answered per workspace, or per resource of the kind its prefix names', () => {
    for (const action of Object.keys(PERMISSION_ACTIONS)) {
      if (WORKSPACE_ACTIONS.includes(action as WorkspaceAction)) continue;
      expect(['document', 'branch', 'project', 'merge-request']).toContain(action.split(':')[0]);
    }
  });
});

/** One route per role action: its `@Access` must say what the catalogue says. */
const ROUTES: Record<Exclude<WorkspaceAction, 'platform:admin' | 'workspace:create'>, () => unknown> = {
  'workspace:view': () => GlossaryController.prototype.list,
  'workspace:contribute': () => ProjectsController.prototype.create,
  'workspace:admin': () => WorkspacesController.prototype.setFeatures,
  // SearchService asks requireHistory when the search names asOf or knownAt (history-audience.spec.ts).
  'workspace:history': () => SearchController.prototype.run,
  // assertMayWrite asks mayPublishDirect on every revision it creates (direct-write.spec.ts).
  'workspace:publish-direct': () => DocumentsController.prototype.createRevision,
  'api-test-suites:generate': () => ApiSpecsController.prototype.generateTestSuite,
  'api-test-suites:run': () => ApiSpecsController.prototype.testRunPlan,
};

describe('each action agrees with its route', () => {
  for (const [action, handler] of Object.entries(ROUTES) as [keyof typeof ROUTES, () => unknown][]) {
    it(action, () => {
      const rule = PERMISSION_ACTIONS[action];
      const spec = Reflect.getMetadata(ACCESS_META, handler() as object) as AccessSpec;
      expect(spec, `${action}: route has no @Access`).toBeDefined();
      expect({ role: spec.role, operator: spec.operator, guests: spec.guests === true, capability: spec.capability }).toEqual({
        role: rule.role,
        operator: 'operator' in rule,
        guests: 'guests' in rule,
        capability: 'capability' in rule ? rule.capability : undefined,
      });
    });
  }
});

/**
 * One route per resource action (#1298): its `@Access(role, source)` is the
 * rule's workspace half, on the resource the prefix names. The rule's level is
 * the route's own (viewer→view, editor→edit, admin→manage) or more, where the
 * handler or service asks `requireLevel` — named in the comment.
 */
const SOURCE = { document: 'document', branch: 'document', project: 'project', 'merge-request': 'merge-request' } as const;
const RESOURCE_ROUTES: Record<Exclude<ResourceAction, 'project:manage-settings'>, () => unknown> = {
  'document:view': () => DocumentsController.prototype.get,
  'document:comment': () => DocumentsController.prototype.createThread,
  'document:edit': () => DocumentsController.prototype.createRevision,
  // ResourceAccessService.update asks requireLevel(manage).
  'document:manage': () => AccessController.prototype.updateDocumentAccess,
  // @History(): requireHistory on the page.
  'document:history': () => DocumentsController.prototype.listRevisions,
  // The handler asks requireLevel(manage).
  'document:publish': () => DocumentsController.prototype.publish,
  // The guard holds `branch` to edit (requireBranches).
  'branch:edit': () => DocumentsController.prototype.createRevision,
  'project:edit': () => ProjectsController.prototype.update,
  // ResourceAccessService.update asks requireLevel(manage).
  'project:manage-access': () => AccessController.prototype.updateProjectAccess,
  'project:manage-gates': () => ProjectApiSettingsController.prototype.update,
  'project:delete': () => ProjectsController.prototype.remove,
  'merge-request:contribute': () => MergeRequestsController.prototype.approve,
  'merge-request:override-checks': () => MergeRequestsController.prototype.overrideLintCheck,
};
const routeLevel = (role: WorkspaceRole): AccessLevel => (role === 'admin' ? 'manage' : role === 'editor' ? 'edit' : 'view');

describe('each resource action agrees with its route', () => {
  for (const [action, handler] of Object.entries(RESOURCE_ROUTES) as [keyof typeof RESOURCE_ROUTES, () => unknown][]) {
    it(action, () => {
      const rule = PERMISSION_ACTIONS[action];
      const spec = Reflect.getMetadata(ACCESS_META, handler() as object) as AccessSpec;
      expect(spec, `${action}: route has no @Access`).toBeDefined();
      expect({ role: spec.role, source: spec.source, operator: spec.operator }).toEqual({
        role: rule.role,
        source: SOURCE[action.split(':')[0] as keyof typeof SOURCE],
        operator: false,
      });
      expect(accessRank(rule.level)).toBeGreaterThanOrEqual(accessRank(routeLevel(rule.role)));
    });
  }

  it('project:manage-settings is the guard of the routes that ask requireProjectManage', () => {
    expect(PERMISSION_ACTIONS['project:manage-settings']).toEqual({ special: 'project-manage' });
    expect(String(ProjectsController.prototype.setMethodology)).toContain('requireProjectManage');
  });
});

// --- the resolver, over a real AccessService and PermissionService on a fake store ---

type Member = { role: WorkspaceRole; trustedOperator?: boolean; capabilities?: MemberCapability[] };
const person = (over: Partial<Principal> = {}): Principal =>
  ({ userId: 'u1', email: 'u@x', displayName: 'U', avatarUrl: null, mode: 'session', isAdmin: false, locale: 'en', ...over }) as Principal;
const DEV = person({ mode: 'dev' });
const PLATFORM = person({ isAdmin: true });
const readKey = person({ mode: 'api-key', apiKey: { scope: 'read', workspaceId: null } as never });

function rig(member: Member | null, policy: { publishMode?: 'review' | 'direct'; historyAudience?: 'everyone' | 'editors'; signup?: boolean } = {}) {
  const row = member && { role: member.role, trustedOperator: member.trustedOperator ?? false, capabilities: member.capabilities ?? [] };
  const prisma = {
    workspace: { findUnique: vi.fn(async () => ({ id: WS, deletedAt: null })) },
    workspaceMember: { findUnique: vi.fn(async () => row) },
    userGroupMember: { findMany: vi.fn(async () => []) },
    accessGrant: { findMany: vi.fn(async () => []) },
    document: { findMany: vi.fn(async () => []) },
    project: { findMany: vi.fn(async () => []) },
  };
  const editing = {
    policy: vi.fn(async () => ({
      publishMode: { effective: policy.publishMode ?? 'review' },
      historyAudience: { effective: policy.historyAudience ?? 'everyone' },
    })),
  };
  const config = { get: (k: string) => ({ AUTH_SIGNUP_ENABLED: policy.signup ?? true })[k] };
  const access = new AccessService(prisma as never, noAuthPolicy);
  const permissions = new PermissionService(prisma as never, access, {} as never, config as never, editing as never);
  const resolver = new PermissionsResolver(access, permissions, config as never, prisma as never);
  return { access, grants: (p: Principal = person()) => resolver.workspaceGrants(p, WS) };
}

const only = (...held: WorkspaceAction[]) =>
  Object.fromEntries(WORKSPACE_ACTIONS.map((a) => [a, a === 'workspace:create' || held.includes(a)]));
const ALL_BUT_PLATFORM = WORKSPACE_ACTIONS.filter((a) => a !== 'platform:admin');

describe('PermissionsResolver', () => {
  it('a guest: history only while everyone may read it', async () => {
    expect(await rig({ role: 'guest' }).grants()).toEqual(only('workspace:history'));
    expect(await rig({ role: 'guest' }, { historyAudience: 'editors' }).grants()).toEqual(only());
  });

  it('a viewer views and reads history; with editors-only history, it does not', async () => {
    expect(await rig({ role: 'viewer' }).grants()).toEqual(only('workspace:view', 'workspace:history'));
    expect(await rig({ role: 'viewer' }, { historyAudience: 'editors' }).grants()).toEqual(only('workspace:view'));
  });

  it('an editor contributes; it publishes directly only in a direct workspace', async () => {
    const base = ['workspace:view', 'workspace:contribute', 'workspace:history'] as const;
    expect(await rig({ role: 'editor' }).grants()).toEqual(only(...base));
    expect(await rig({ role: 'editor' }, { publishMode: 'direct' }).grants()).toEqual(only(...base, 'workspace:publish-direct'));
  });

  it('a capability is its own grant, beside the role', async () => {
    expect(await rig({ role: 'viewer', capabilities: ['api-test-suites.run'] }).grants()).toEqual(
      only('workspace:view', 'workspace:history', 'api-test-suites:run'),
    );
  });

  it('a workspace admin holds everything in it; a platform admin and the dev principal everything', async () => {
    expect(await rig({ role: 'admin' }).grants()).toEqual(only(...ALL_BUT_PLATFORM));
    expect(await rig(null).grants(PLATFORM)).toEqual(only(...WORKSPACE_ACTIONS));
    expect(await rig(null).grants(DEV)).toEqual(only(...WORKSPACE_ACTIONS));
  });

  it('a read-only key on an admin writes nothing', async () => {
    expect(await rig({ role: 'admin' }).grants(readKey)).toEqual(
      only('workspace:view', 'workspace:history', 'api-test-suites:generate', 'api-test-suites:run'),
    );
  });

  it('a non-member is refused everything but what needs no membership', async () => {
    expect(await rig(null).grants()).toEqual(only());
  });
});

describe('actions with no route mirror their guard', () => {
  it('platform:admin is what @PlatformAdmin() admits', async () => {
    const guard = new AclGuard(
      { get: () => undefined, getAllAndOverride: (key: string) => key === PLATFORM_ADMIN_META } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const admits = (p: Principal) =>
      guard
        .canActivate({ getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => ({ principal: p, method: 'GET' }) }) } as never)
        .then(() => true, () => false);
    for (const p of [person(), PLATFORM, DEV]) {
      expect((await rig({ role: 'admin' }).grants(p))['platform:admin']).toBe(await admits(p));
    }
  });

  it('workspace:create is workspaceCreationRefusal, as WorkspacesService.create asks it', async () => {
    const pinned = person({ mode: 'api-key', apiKey: { scope: 'write', workspaceId: WS } as never });
    for (const signup of [true, false]) {
      for (const p of [person(), PLATFORM, DEV, pinned]) {
        expect((await rig({ role: 'admin' }, { signup }).grants(p))['workspace:create']).toBe(workspaceCreationRefusal(p, signup) === null);
      }
    }
  });
});

// --- per resource (#1298): the resolver over levelOn fixtures ---

const P = '22222222-2222-4222-8222-222222222222';
const D = '33333333-3333-4333-8333-333333333333';
const B = '44444444-4444-4444-8444-444444444444';
type Grant = { resourceId: string; resourceType?: string; subjectType: 'user' | 'group'; subjectId: string; level: string };
type Where = Record<string, any>;
const grantMatches = (where: Where, g: Grant): boolean => {
  if (where.resourceType && (g.resourceType ?? 'document') !== where.resourceType) return false;
  if (typeof where.resourceId === 'string' && g.resourceId !== where.resourceId) return false;
  if (where.resourceId?.in && !where.resourceId.in.includes(g.resourceId)) return false;
  if (where.OR) {
    return (where.OR as Where[]).some(
      (c) =>
        c.resourceId?.in?.includes(g.resourceId) ||
        (c.subjectType === g.subjectType && (c.subjectId === g.subjectId || c.subjectId?.in?.includes(g.subjectId))),
    );
  }
  return true;
};

function resourceRig(
  member: Member | null,
  world: {
    projectRestricted?: boolean;
    pageRestricted?: boolean;
    grants?: Grant[];
    historyAudience?: 'everyone' | 'editors';
    branch?: { id: string; ownerId: string; restricted: true };
  } = {},
) {
  const row = member && { role: member.role, trustedOperator: false, capabilities: [] };
  const grants = world.grants ?? [];
  const restricted = [...(world.projectRestricted ? [P] : []), ...(world.pageRestricted ? [D] : [])];
  const prisma = {
    workspace: { findUnique: vi.fn(async () => ({ id: WS, deletedAt: null })) },
    workspaceMember: { findUnique: vi.fn(async () => row) },
    userGroupMember: { findMany: vi.fn(async () => []) },
    accessGrant: { findMany: vi.fn(async ({ where }: { where: Where }) => grants.filter((g) => grantMatches(where, g))) },
    document: {
      findUnique: vi.fn(async () => ({ workspaceId: WS, projectId: P, path: `/${D}/`, defaultBranch: 'main' })),
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        where.restricted ? (world.pageRestricted ? [{ id: D }] : []) : [{ id: D, title: 'D', restricted: world.pageRestricted ?? false }],
      ),
    },
    project: {
      findUnique: vi.fn(async () => ({ workspaceId: WS, name: 'P', restricted: world.projectRestricted ?? false })),
      findMany: vi.fn(async () => (world.projectRestricted ? [{ id: P }] : [])),
    },
    documentBranch: { findFirst: vi.fn(async () => world.branch ?? null), findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => restricted.map((id) => ({ id }))),
  };
  const editing = {
    policy: vi.fn(async () => ({ publishMode: { effective: 'review' }, historyAudience: { effective: world.historyAudience ?? 'everyone' } })),
  };
  const config = { get: () => true };
  const access = new AccessService(prisma as never, noAuthPolicy);
  const permissions = new PermissionService(prisma as never, access, {} as never, config as never, editing as never);
  const resolver = new PermissionsResolver(access, permissions, config as never, prisma as never);
  return {
    prisma,
    permissions,
    page: (p: Principal = person(), branch?: string) => resolver.forDocument(p, D, branch),
    project: (p: Principal = person()) => resolver.forProject(p, P),
    review: (p: Principal = person()) => resolver.forMergeRequest(p, D),
  };
}
const grant = (resourceId: string, level: string, extra: Partial<Grant> = {}): Grant => ({ resourceId, subjectType: 'user', subjectId: 'u1', level, ...extra });
/** Restricted to view for u1: someone else edits it, which is what makes the page's edit gate (`levelOn`). */
const viewOnly = [grant(D, 'view'), grant(D, 'edit', { subjectId: 'u2' })];

describe('PermissionsResolver per resource', () => {
  it('an editor on a page restricted to view: reads and comments, never edits, shares or publishes', async () => {
    const page = await resourceRig({ role: 'editor' }, { pageRestricted: true, grants: viewOnly }).page();
    expect(page).toMatchObject({ 'document:view': true, 'document:comment': true, 'document:edit': false, 'document:manage': false });
    expect(page).toMatchObject({ 'document:publish': false, 'branch:edit': false });
  });

  it('an editor on an open page edits it and, nobody managing it, may restrict it', async () => {
    expect(await resourceRig({ role: 'editor' }).page()).toMatchObject({ 'document:edit': true, 'document:manage': true });
  });

  it('a guest edits a page granted at edit and comments on one granted at view; never manages', async () => {
    expect(await resourceRig({ role: 'guest' }, { grants: [grant(D, 'edit')] }).page()).toMatchObject({
      'document:view': true,
      'document:comment': true,
      'document:edit': true,
      'document:manage': false,
    });
    expect(await resourceRig({ role: 'guest' }, { grants: [grant(D, 'view')] }).page()).toMatchObject({
      'document:comment': true,
      'document:edit': false,
    });
  });

  it('a read-only key reads and comments, as its routes let it, and writes nothing', async () => {
    const page = await resourceRig({ role: 'editor' }).page(readKey);
    expect(page).toMatchObject({ 'document:view': true, 'document:comment': true, 'document:edit': false, 'document:manage': false });
  });

  it("history with an editors-only audience follows the page's level", async () => {
    const editors = { historyAudience: 'editors' as const };
    expect((await resourceRig({ role: 'viewer' }, editors).page())['document:history']).toBe(false);
    expect((await resourceRig({ role: 'viewer' }).page())['document:history']).toBe(true);
    expect((await resourceRig({ role: 'editor' }, editors).page())['document:history']).toBe(true);
    expect((await resourceRig({ role: 'guest' }, { ...editors, grants: [grant(D, 'edit')] }).page())['document:history']).toBe(true);
    expect((await resourceRig({ role: 'editor' }, { ...editors, pageRestricted: true, grants: viewOnly }).page())['document:history']).toBe(false);
  });

  it('branch:edit narrows by the private branch named', async () => {
    const branch = { id: B, ownerId: 'someone-else', restricted: true as const };
    expect((await resourceRig({ role: 'editor' }, { branch, grants: [grant(B, 'view', { resourceType: 'branch' })] }).page(person(), 'x'))['branch:edit']).toBe(false);
    expect((await resourceRig({ role: 'editor' }, { branch, grants: [grant(B, 'edit', { resourceType: 'branch' })] }).page(person(), 'x'))['branch:edit']).toBe(true);
    expect((await resourceRig({ role: 'editor' }, { branch }).page())['branch:edit']).toBe(true);
  });

  it('an unmanaged project: an editor edits it and may restrict it, but its settings need a manage grant', async () => {
    expect(await resourceRig({ role: 'editor' }).project()).toEqual({
      'project:edit': true,
      'project:manage-access': true,
      'project:manage-settings': false,
      'project:manage-gates': false,
      'project:delete': false,
    });
  });

  it("an explicit manage grant makes an editor the project's maintainer, still not its gates", async () => {
    expect(await resourceRig({ role: 'editor' }, { grants: [grant(P, 'manage')] }).project()).toMatchObject({
      'project:manage-settings': true,
      'project:manage-gates': false,
    });
  });

  it('a workspace admin holds every action; a viewer none of the writes', async () => {
    const admin = resourceRig({ role: 'admin' });
    expect(Object.values(await admin.page()).every(Boolean)).toBe(true);
    expect(Object.values(await admin.project()).every(Boolean)).toBe(true);
    expect(await admin.review()).toEqual({ 'merge-request:contribute': true, 'merge-request:override-checks': true });
    expect(await resourceRig({ role: 'viewer' }).review()).toEqual({ 'merge-request:contribute': false, 'merge-request:override-checks': false });
  });

  it('a page-editor contributes to its merge requests; overriding checks stays an admin act', async () => {
    expect(await resourceRig({ role: 'editor' }).review()).toEqual({ 'merge-request:contribute': true, 'merge-request:override-checks': false });
  });
});

describe('rowLevels: the tree and the list', () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({
    id: `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`,
    projectId: P,
    path: `/${D}/55555555-5555-4555-8555-${String(i).padStart(12, '0')}/`,
  }));

  it('500 rows under a page restricted to view cost two reads, and every row reads view', async () => {
    const { prisma, permissions } = resourceRig({ role: 'editor' }, { pageRestricted: true, grants: viewOnly });
    const scope = await permissions.scopeFor(person(), WS);
    prisma.accessGrant.findMany.mockClear();
    const levelOf = await permissions.rowLevels(scope);
    expect(rows.map(levelOf).every((l) => l === 'view')).toBe(true);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.accessGrant.findMany).toHaveBeenCalledTimes(1);
  });

  it('agrees with levelFor on the page itself, for a guest and a member alike', async () => {
    for (const [member, grants] of [
      [{ role: 'guest' as const }, [grant(D, 'edit')]],
      [{ role: 'editor' as const }, viewOnly],
      [{ role: 'viewer' as const }, []],
    ] as const) {
      const { permissions } = resourceRig(member, { pageRestricted: member.role === 'editor', grants: [...grants] });
      const scope = await permissions.scopeFor(person(), WS);
      const levelOf = await permissions.rowLevels(scope);
      expect(levelOf({ id: D, projectId: P, path: `/${D}/` })).toBe(await permissions.levelFor(scope, { type: 'document', id: D }));
    }
  });

  it('an admin costs no read at all', async () => {
    const { prisma, permissions } = resourceRig({ role: 'admin' });
    const levelOf = await permissions.rowLevels(await permissions.scopeFor(person(), WS));
    expect(levelOf(rows[0]!)).toBe('manage');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('GET /v1/documents/:id/permissions', () => {
  it('is never kept, so two callers can never share a 304 for it (the page detail validator is shared)', () => {
    expect(Reflect.getMetadata(CACHE_POLICY_META, DocumentsController.prototype.permissionsOf)).toBe('no-store');
  });
});
