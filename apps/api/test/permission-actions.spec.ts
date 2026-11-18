import { describe, expect, it, vi } from 'vitest';
import {
  MEMBER_CAPABILITIES,
  PERMISSION_ACTIONS,
  WORKSPACE_ACTIONS,
  type MemberCapability,
  type WorkspaceAction,
  type WorkspaceRole,
} from '@knowledge/contracts';
import { ACCESS_META, PLATFORM_ADMIN_META, type AccessSpec } from '../src/auth/access.decorator.js';
import { AccessService } from '../src/auth/access.service.js';
import { AclGuard } from '../src/auth/acl.guard.js';
import type { Principal } from '../src/auth/principal.js';
import { workspaceCreationRefusal } from '../src/auth/workspace-creation.js';
import { PermissionService } from '../src/permissions/permission.service.js';
import { PermissionsResolver } from '../src/permissions/permissions.resolver.js';
import { ApiSpecsController } from '../src/api-specs/api-specs.controller.js';
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

  it('phase 1 answers every action per workspace', () => {
    expect(WORKSPACE_ACTIONS).toEqual(Object.keys(PERMISSION_ACTIONS));
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
  const resolver = new PermissionsResolver(access, permissions, config as never);
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
