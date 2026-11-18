import type { AccessLevel, MemberCapability, WorkspaceRole } from '@knowledge/contracts/identity';

/**
 * What the web may ask "may I" about (#1245), one `resource:action` key per
 * control it gates. The API owns every answer; the web reads booleans it
 * computed (`GET /v1/me/permissions`). Each action states its rule in the
 * terms the enforcing guard already uses, so the drift spec
 * (`apps/api/test/permission-actions.spec.ts`) can hold it to a route.
 *
 * Derived, never stored: SSO, SCIM and manual edits keep writing a role,
 * `trustedOperator`, capabilities and grants.
 */
export type PermissionRule =
  /**
   * `requireRole(role, operator, { allowGuest: guests, capability })`, as the route's `@Access`.
   * `history` adds `requireHistory` with no page; `publish-direct` adds the
   * publish mode (`assertMayWrite` in the documents service).
   */
  | { role: WorkspaceRole; operator?: true; guests?: true; capability?: MemberCapability; special?: 'history' | 'publish-direct' }
  /** The caller's level on one page or project (`levelOn`). */
  | { level: AccessLevel }
  /** A guard with no role behind it. */
  | { special: 'project-manage' | 'platform-admin' | 'workspace-create' };

export const PERMISSION_ACTIONS = {
  /** `@PlatformAdmin()` routes: the admin console and user management. */
  'platform:admin': { special: 'platform-admin' },
  /** `POST /v1/workspaces` (`workspaceCreationRefusal`). */
  'workspace:create': { special: 'workspace-create' },
  /** Reads the workspace beyond what is granted: a guest does not. Commenting is a viewer action (feature 15). */
  'workspace:view': { role: 'viewer' },
  /** Writes pages: create, edit, branch, open a merge request. */
  'workspace:contribute': { role: 'editor' },
  /** The workspace's settings, members and gates. */
  'workspace:admin': { role: 'admin' },
  /** Page history with no single page (as-of reads); a page's own history is its level (#958). */
  'workspace:history': { role: 'viewer', guests: true, special: 'history' },
  /** Writes a published page's default branch without a merge request (#958). */
  'workspace:publish-direct': { role: 'editor', special: 'publish-direct' },
  'api-test-suites:generate': { role: 'viewer', capability: 'api-test-suites.generate' },
  'api-test-suites:run': { role: 'viewer', capability: 'api-test-suites.run' },
} as const satisfies Record<`${string}:${string}`, PermissionRule>;

export type PermissionAction = keyof typeof PERMISSION_ACTIONS;
/** Answered once per workspace. */
export type WorkspaceAction = { [A in PermissionAction]: (typeof PERMISSION_ACTIONS)[A] extends { level: AccessLevel } | { special: 'project-manage' } ? never : A }[PermissionAction];
/** Answered per page or project, on the resource's own read (#1298). */
export type ResourceAction = Exclude<PermissionAction, WorkspaceAction>;

const isResourceRule = (rule: PermissionRule): boolean => 'level' in rule || ('special' in rule && rule.special === 'project-manage');

export const WORKSPACE_ACTIONS = (Object.keys(PERMISSION_ACTIONS) as PermissionAction[]).filter(
  (a) => !isResourceRule(PERMISSION_ACTIONS[a]),
) as WorkspaceAction[];

/** `GET /v1/me/permissions?workspaceId=`: every workspace action, answered for the caller. */
export type MePermissionsResponse = Record<WorkspaceAction, boolean>;
