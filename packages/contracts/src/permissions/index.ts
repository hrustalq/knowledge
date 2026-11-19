import { accessRank, type AccessLevel, type EffectiveAccessLevel, type MemberCapability, type ProjectSummary, type WorkspaceRole } from '@knowledge/contracts/identity';
import type { CreateMergeRequestResponse } from '@knowledge/contracts/reviews';

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
  /**
   * The caller's level on one page or project (`levelOn`) behind a route's
   * `@Access(role, <resource>)`. `role` is the workspace half, which a guest
   * passes on a viewer or editor route as `requireResource` lets them; `level`
   * is what `levelOn` must reach: the route's own (viewer→view, editor→edit,
   * admin→manage), or more where the service asks `requireLevel`. `history`
   * adds `requireHistory` on the page; `branch` adds the branch level
   * (`branchLevel`) of the branch named, as `requireBranches(…, 'edit')` does.
   */
  | { role: WorkspaceRole; level: AccessLevel; special?: 'history' | 'branch' }
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

  // Per resource (#1298): answered on the resource's own read.
  'document:view': { role: 'viewer', level: 'view' },
  /** Threads and comments (feature 15): a reader's act, so a guest holding a view grant comments. */
  'document:comment': { role: 'viewer', level: 'view' },
  /** Revisions, branches, merge requests, share links, verification and the drift check. */
  'document:edit': { role: 'editor', level: 'edit' },
  /** The page's restriction and grants (`ResourceAccessService.update` asks manage). */
  'document:manage': { role: 'viewer', level: 'manage' },
  /** The page's own history (#958): its level, the workspace's `history_audience`. */
  'document:history': { role: 'viewer', level: 'view', special: 'history' },
  /** Open a private draft to the workspace (`POST :id/publish` asks manage on the page). */
  'document:publish': { role: 'editor', level: 'manage' },
  /** Write the branch the page is read on (`?branch=`); the default branch when none is named. */
  'branch:edit': { role: 'editor', level: 'edit', special: 'branch' },
  /** The project's name, description and face. */
  'project:edit': { role: 'editor', level: 'edit' },
  /** The project's restriction and grants (`ResourceAccessService.update` asks manage). */
  'project:manage-access': { role: 'viewer', level: 'manage' },
  /**
   * The project's settings (#919): `requireProjectManage`, which needs an
   * explicit manage grant. Not `project:manage-access`: on a project nobody
   * manages, `levelOn` hands manage to every editor, and a setting is not theirs.
   */
  'project:manage-settings': { special: 'project-manage' },
  /** The merge gates (lint, breaking-API): `@Access('admin', 'project')`. */
  'project:manage-gates': { role: 'admin', level: 'manage' },
  'project:delete': { role: 'admin', level: 'manage' },
  /** Approve, merge, update the branch, close, review threads. */
  'merge-request:contribute': { role: 'editor', level: 'edit' },
  /** Override a failed check, acknowledge breaking API changes. */
  'merge-request:override-checks': { role: 'admin', level: 'manage' },
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

type ActionsOf<R extends string> = Extract<ResourceAction, `${R}:${string}`>;
export type DocumentAction = ActionsOf<'document' | 'branch'>;
export type ProjectAction = ActionsOf<'project'>;
export type MergeRequestAction = ActionsOf<'merge-request'>;

/** The resource actions of one kind, in catalogue order: `document` also answers `branch:*`. */
export const resourceActions = <A extends ResourceAction>(...prefixes: string[]): A[] =>
  (Object.keys(PERMISSION_ACTIONS) as PermissionAction[]).filter(
    (a) => isResourceRule(PERMISSION_ACTIONS[a]) && prefixes.includes(a.slice(0, a.indexOf(':'))),
  ) as A[];

/**
 * `GET /v1/documents/:id/permissions?branch=`. A sibling of the page detail,
 * whose validator is shared across callers (docs/architecture/10-caching.md),
 * so a per-caller answer cannot ride in that body.
 */
export type DocumentPermissionsResponse = Record<DocumentAction, boolean>;
export type ProjectPermissions = Record<ProjectAction, boolean>;
export type MergeRequestPermissions = Record<MergeRequestAction, boolean>;

/** `GET /v1/projects/:id`: the project and what the caller may do with it. */
export interface ProjectDetailResponse extends ProjectSummary {
  permissions: ProjectPermissions;
}

/** `GET /v1/merge-requests/:id`: the merge request and what the caller may do with it (its page's level). */
export interface MergeRequestDetailResponse extends CreateMergeRequestResponse {
  permissions: MergeRequestPermissions;
}

/** A tree or list row's `level` reaching `needed` (`levelOn` answered it per row). */
export const levelReaches = (level: EffectiveAccessLevel | undefined, needed: AccessLevel): boolean =>
  level !== undefined && accessRank(level) >= accessRank(needed);
