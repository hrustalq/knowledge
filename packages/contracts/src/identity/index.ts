import type { IngestionJobStatus, Locale, RevisionStatus } from '@knowledge/contracts/core';
import type { FactExtractor } from '@knowledge/contracts/graph';

// stale detection / reindex scheduling, historical fact queries
// ---------------------------------------------------------------------------

/**
 * Workspace role hierarchy: guest < viewer < editor < admin.
 *
 * `guest` sits below the ladder rather than on it: a guest reads nothing in the
 * workspace except what is granted to them or their groups (#76), so every
 * workspace-level `@Access('viewer', …)` route refuses one without knowing
 * guests exist.
 */
export const WORKSPACE_ROLES = ['guest', 'viewer', 'editor', 'admin'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export interface WorkspaceMembership {
  workspaceId: string;
  role: WorkspaceRole;
  /** Gate for POST /v1/graph/query / knowledge.query_graph (plan.md section 9). */
  trustedOperator: boolean;
}

// GET /v1/me
/**
 * Where to fetch a picture, or null when there is none and the face is drawn
 * from initials (people) or a monogram (projects) instead.
 *
 * Always a bare `/v1/...` path, never an absolute URL: one value has to work
 * through the dev proxy, in production, and during SSR. The browser turns it
 * into something an `<img>` can load with `resolveAssetUrl()`, which adds the
 * host and the `?token=` — an `<img>` cannot send an Authorization header. A
 * `?v=` stamp rides along, because replacing a picture reuses its key and would
 * otherwise be invisible to everyone who had already loaded the old one.
 */
export type AvatarUrl = string | null;

export interface MeResponse {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: AvatarUrl;
  /** 'dev' = AUTH_MODE=none (full access); 'api-key' = Bearer API key; 'session' = login session token. */
  mode: 'dev' | 'api-key' | 'session';
  /** Platform admin (users.is_admin): full access to every workspace + user management. */
  isAdmin: boolean;
  /** UI + API language (docs/features/18). 'en' for the dev principal, which has no users row. */
  locale: Locale;
  /** The address is proven (docs/features/41). Always true for the dev principal. */
  emailVerified: boolean;
  /**
   * AUTH_REQUIRE_VERIFIED_EMAIL: while `emailVerified` is false, every route but
   * /me, logout and resend-verification answers 403 `emailUnverified`.
   */
  emailVerificationRequired: boolean;
  /** Empty in dev mode (the dev principal is admin+operator everywhere). */
  memberships: WorkspaceMembership[];
}


export interface GraphQueryResponse {
  rows: Record<string, unknown>[];
  rowCount: number;
  /** True when the row cap cut the result off. */
  truncated: boolean;
  durationMs: number;
}

export interface AuditLogEntry {
  id: string;
  workspaceId: string;
  /** users.id, or a synthetic actor ("dev", "mcp-operator") outside api-key mode. */
  actor: string;
  action: string;
  params: Record<string, unknown>;
  rowCount: number | null;
  durationMs: number | null;
  ok: boolean;
  error: string | null;
  createdAt: string;
}

// GET /v1/audit-logs?workspaceId=
export interface ListAuditLogsResponse {
  workspaceId: string;
  entries: AuditLogEntry[];
}

/** A fact as asserted at a point in the revision DAG (Phase 5 historical queries). */
export interface HistoricalFact {
  type: string;
  targetKey: string;
  entityType: string;
  name: string;
  extractor: FactExtractor | string;
  confidence: number;
  /** Revision that asserted the fact; null for un-anchored document-level facts. */
  assertedByRevisionId: string | null;
}

// GET /v1/documents/:id/facts?at=<revisionId>
export interface FactsAtResponse {
  documentId: string;
  atRevisionId: string;
  /**
   * The ancestor revision whose revision-scoped fact set is the effective
   * snapshot at `at` (null when no ancestor asserted revision-scoped facts).
   */
  effectiveRevisionId: string | null;
  facts: HistoricalFact[];
}

export interface FactTimelineEntry {
  type: string;
  targetKey: string;
  extractor: FactExtractor | string;
  status: 'active' | 'removed';
  introducedInRevisionId: string | null;
  introducedAt: string | null;
  /** First later revision that asserted facts without this one (removed-facts audit). */
  removedInRevisionId: string | null;
  removedAt: string | null;
}

// GET /v1/documents/:id/facts/timeline?branch=
export interface FactTimelineResponse {
  documentId: string;
  branch: string;
  entries: FactTimelineEntry[];
}

// GET /v1/ingestion/jobs/:id
export interface IngestionJobInfo {
  jobId: string;
  workspaceId: string;
  revisionId: string;
  type: string;
  status: IngestionJobStatus | string;
  attempts: number;
  error: unknown;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

// GET /v1/ingestion/stale?workspaceId=
export interface StaleReportResponse {
  workspaceId: string;
  /** Current embedding signature (provider:model:dim); heads indexed under a different one are drifted. */
  embeddingSignature: string;
  driftedHeads: Array<{
    documentId: string;
    revisionId: string;
    title: string;
    embeddingModel: string | null;
    indexedAt: string | null;
  }>;
  stuckIndexing: Array<{ jobId: string; revisionId: string; startedAt: string | null }>;
  failedJobs: Array<{ jobId: string; revisionId: string; attempts: number; error: unknown }>;
}

export interface ReindexResponse {
  workspaceId: string;
  enqueued: number;
  jobIds: string[];
}

// ---------------------------------------------------------------------------
// Product features (docs/features): categorization, nesting, full content,
// Phase 5 api-key auth) + users & access-control management.
// ---------------------------------------------------------------------------



/** Returned by signup and login: a `ks_` session token (send as Bearer). */
export interface AuthSessionResponse {
  token: string;
  expiresAt: string;
  me: MeResponse;
}

// POST /v1/auth/logout
export interface LogoutResponse {
  ok: boolean;
}

/**
 * POST /v1/auth/url-ticket (#102): a single-use `kt_` credential for a URL
 * that cannot carry a header (EventSource). Put it in `?token=`; it is
 * redeemed on first use and expires at `expiresAt` either way.
 */
export interface UrlTicketResponse {
  ticket: string;
  expiresAt: string;
}

export interface ForgotPasswordResponse {
  /** Always true — the endpoint never reveals whether the email exists. */
  ok: boolean;
  /** Reset token echoed back outside production only, so a dev flow needs no inbox. */
  debugToken?: string;
}

/** POST /v1/auth/verify-email (docs/features/41). */
export interface VerifyEmailResponse {
  ok: boolean;
}

/** POST /v1/auth/resend-verification. `alreadyVerified` = nothing was sent. */
export interface ResendVerificationResponse {
  ok: boolean;
  alreadyVerified: boolean;
  /** Verification token echoed back outside production only. */
  debugToken?: string;
}

export interface ResetPasswordResponse {
  ok: boolean;
}


// ---------------------------------------------------------------------------
// Users management (platform admin)
// ---------------------------------------------------------------------------

export interface UserSummary {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: AvatarUrl;
  isAdmin: boolean;
  /** Disabled users cannot authenticate (sessions and API keys stop working). */
  disabled: boolean;
  hasPassword: boolean;
  /** users.email_verified_at is set (docs/features/41). */
  emailVerified: boolean;
  hasApiKey: boolean;
  createdAt: string;
  memberships: WorkspaceMembership[];
}

// GET /v1/users
export interface ListUsersResponse {
  users: UserSummary[];
}

// ---------------------------------------------------------------------------
// Profiles — one workspace member as a work record (identity, what is open on
// them, what they have touched). Workspace-scoped because activity_log is: a
// profile answers "who is this, here", never "who is this, everywhere".
// ---------------------------------------------------------------------------

/** A page this person has written on, newest touch first. */
export interface ProfilePage {
  documentId: string;
  title: string;
  category: string;
  projectId: string;
  /** Head-revision status, for the lifecycle dot. */
  status: RevisionStatus | null;
  /** True when this person created the document, not merely revised it. */
  authored: boolean;
  revisions: number;
  lastTouchedAt: string;
}

/** Work still owed, in the product's own terms. */
export interface ProfileOpenWork {
  /** Merge requests they opened that are still open. */
  authoredMergeRequests: number;
  /** Open merge requests where they are a reviewer and have not approved. */
  awaitingTheirReview: number;
  /** Unresolved, resolvable threads they have commented in. */
  unresolvedThreads: number;
}

// GET /v1/profiles/:userId?workspaceId=
export interface UserProfileResponse {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: AvatarUrl;
  /** Platform admin (users.is_admin). */
  isAdmin: boolean;
  disabled: boolean;
  /** users.created_at — when the account was made, not when they joined here. */
  createdAt: string;
  /** Null when the subject is not a member of this workspace (a platform admin looking in). */
  role: WorkspaceRole | null;
  trustedOperator: boolean;
  /** workspace_members.created_at — when they joined THIS workspace. */
  memberSince: string | null;
  /** True when this profile is the caller's own. */
  isSelf: boolean;
  hasPassword: boolean;
  hasApiKey: boolean;
  pages: ProfilePage[];
  /** Distinct documents they have revised in this workspace (pages[] is capped). */
  pageCount: number;
  openWork: ProfileOpenWork;
}

// POST /v1/me/api-key — rotate the caller's key; the plaintext is shown once.
export interface RotateApiKeyResponse {
  /** `kn_…`. Never retrievable again — only its SHA-256 is stored. */
  apiKey: string;
  rotatedAt: string;
}

// ---------------------------------------------------------------------------
// API keys (docs/features/33) — many named keys per person, each optionally
// narrowed. A key can only ever do less than the person who minted it: the
// narrowing is applied on top of their workspace role, never instead of it.
// ---------------------------------------------------------------------------

/**
 * `read` caps every workspace at the viewer role; `write` leaves the owner's
 * own role in force. Closed: the guard, the form and the MCP tool filter all
 * read this one list.
 */
export const API_KEY_SCOPES = ['read', 'write'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface ApiKeyInfo {
  id: string;
  name: string;
  /** The first characters of the key (`kn_1a2b3c4d`), enough to recognise it in a config file. */
  prefix: string;
  scope: ApiKeyScope;
  /** Pinned to one workspace, or null for every workspace the owner belongs to. */
  workspaceId: string | null;
  expiresAt: string | null;
  /** Coarse — refreshed at most once a minute, so it answers "is this still in use", not "when exactly". */
  lastUsedAt: string | null;
  createdAt: string;
}

// GET /v1/me/api-keys
export interface ListApiKeysResponse {
  keys: ApiKeyInfo[];
}

// POST /v1/me/api-keys — the plaintext is in this response and nowhere else, ever.
export interface CreateApiKeyResponse {
  key: ApiKeyInfo;
  /** `kn_…`. Only its SHA-256 is stored. */
  apiKey: string;
}

// ---------------------------------------------------------------------------
// MCP over HTTP (docs/features/33) — what a client needs to connect.
// ---------------------------------------------------------------------------

export interface McpToolSummary {
  name: string;
  description: string;
  /** Mirrors the tool's MCP `readOnlyHint`: false means it can change the knowledge base. */
  readOnly: boolean;
}

// GET /v1/mcp/connection
export interface McpConnectionInfo {
  /** Streamable HTTP endpoint, absolute — this is what goes into a client's config. */
  url: string;
  /** The server key used in every generated config snippet. */
  serverName: string;
  /** 'none' means the server accepts any caller as the dev principal and no key is needed. */
  authMode: 'none' | 'api-key';
  version: string;
  /** Tools the calling credential would be offered. */
  tools: McpToolSummary[];
}



// ---------------------------------------------------------------------------
// Access control management (workspace members)
// ---------------------------------------------------------------------------

export interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  createdAt: string;
  memberCount: number;
  /** Caller's role in this workspace (null for platform admins listing foreign workspaces). */
  myRole: WorkspaceRole | null;
}

// GET /v1/workspaces
export interface ListWorkspacesResponse {
  workspaces: WorkspaceSummary[];
}

export interface CreateWorkspaceResponse {
  workspaceId: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Projects — the organizational layer between a workspace and its documents.
// Projects carry no ACLs of their own: access is resolved at the workspace.
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  projectId: string;
  workspaceId: string;
  name: string;
  description: string | null;
  /** An uploaded picture. Null when the project uses an emoji, or neither. */
  avatarUrl: AvatarUrl;
  /**
   * A chosen emoji, drawn on `avatarColor`. Null when the project has a picture
   * or neither — the three states are exclusive, and the API clears whichever
   * one the write did not set.
   *
   * Worth offering beside an upload because a project tile is 20px in the
   * sidebar, where an emoji stays legible and a scaled-down photograph does not.
   */
  avatarEmoji: string | null;
  /** Backs the emoji only; an image brings its own colours. Hex, e.g. `#3b82f6`. */
  avatarColor: string | null;
  /** Pages in it the caller may open. */
  documentCount: number;
  createdAt: string;
  /** Only grantees (and admins) open it or anything in it (#76). */
  restricted?: boolean;
}

export interface ListProjectsResponse {
  projects: ProjectSummary[];
  /** Always null when the request carried no `limit`. */
  nextCursor: string | null;
}

export interface CreateProjectResponse {
  project: ProjectSummary;
}


// ---------------------------------------------------------------------------
// Deleting a project — GET /v1/projects/:id/deletion-preview,
// DELETE /v1/projects/:id?moveContentsTo=
//
// Removal is *move-then-delete*, not a cascade. Documents are never deleted
// anywhere in this product — revisions are immutable and the S3 keys, graph
// vertices, chunks and merge requests all hang off them — so a project's
// contents are reassigned to a sibling project and the emptied project is then
// dropped. Since a workspace always keeps at least one project, a non-empty
// project always has somewhere to move to.
//
// The preview exists so the warning can name what is about to move before it
// moves. It is derived on every request with no stored table, exactly as
// ProjectOverviewResponse is.
// ---------------------------------------------------------------------------

/** What a project holds, and therefore what a deletion has to relocate. */
export interface ProjectDeletionCounts {
  documents: number;
  glossaryTerms: number;
  connectors: number;
  workflowDefinitions: number;
  /**
   * Runs that are `pending | running | awaiting-review | paused` — work a move
   * relocates mid-flight, which is worth saying out loud before it happens.
   */
  activeWorkflowRuns: number;
  /** Imports still `awaiting-upload | queued | running`: their destination changes under them. */
  pendingImports: number;
  /**
   * People watching the project itself. Not moved and not blocking — the
   * subscriptions go away with their subject — but disclosed, because those
   * people stop hearing about this work without ever pressing anything.
   */
  watchers: number;
}

/**
 * How a project's contents are dealt with.
 *
 * `move` is the safe default and the shape the product is built for: pages are
 * never deleted, so they are reassigned to a sibling project. `cascade`
 * destroys them along with everything downstream — revisions, stored files,
 * merge requests, discussions, workflow runs, graph vertices and search index
 * entries — and is the only operation in the product that removes a page at
 * all. It is irreversible and there is no undo, so it is gated on echoing the
 * project's name back (`confirm`), server-side, not only in the dialog.
 */
export const PROJECT_DELETION_MODES = ['move', 'cascade'] as const;
export type ProjectDeletionMode = (typeof PROJECT_DELETION_MODES)[number];

/**
 * What a cascade destroys, beyond the holdings a move would relocate.
 *
 * Reported separately from `ProjectDeletionCounts` because these are the
 * numbers that make the difference between the two modes legible: a project
 * with 12 pages is also 300 revisions and 340 files in object storage, and the
 * second number is the one that says what "delete everything" costs.
 */
export interface ProjectCascadeCounts {
  documents: number;
  revisions: number;
  attachments: number;
  mergeRequests: number;
  /** Review threads and page comment threads together — every discussion lost. */
  discussions: number;
  workflowRuns: number;
  /** Objects in storage: each revision's source and normalized JSON, plus attachments. */
  storedFiles: number;
}

export interface ProjectDeletionPreview {
  projectId: string;
  name: string;
  /** Holds nothing at all, so it can be deleted outright with no destination. */
  empty: boolean;
  /**
   * The workspace's only project. Nothing can be done about this one: the next
   * page created would have nowhere to go, so the delete is refused whatever
   * the project holds.
   */
  lastInWorkspace: boolean;
  counts: ProjectDeletionCounts;
  /**
   * Terms this project defines that the destination already defines.
   * `glossary_terms` is unique on `(project_id, term)`, so both cannot survive
   * the move: the destination's definition wins and these rows are dropped.
   * Empty unless the request named a `target`.
   */
  glossaryConflicts: string[];
  /**
   * What choosing `cascade` would destroy. Always present, so the dialog can
   * show the price of the destructive option without a second round trip —
   * the point of the preview is that both choices are legible before either is
   * taken.
   */
  cascade: ProjectCascadeCounts;
}


export interface DeleteProjectResponse {
  deleted: true;
  mode: ProjectDeletionMode;
  /** The project its contents were moved into. Null on a cascade, or when empty. */
  movedTo: string | null;
  /** What actually moved. Zeroes throughout on a cascade, or when empty. */
  moved: ProjectDeletionCounts;
  /** What was destroyed. Null unless the mode was `cascade`. */
  destroyed: ProjectCascadeCounts | null;
  /** Terms dropped in favour of the destination's own definition. */
  droppedGlossaryTerms: string[];
}

// ---------------------------------------------------------------------------
// GET /v1/projects/:id/overview — what a project *is*, for the page you read
// rather than the form you edit it in.
//
// Derived on every request, with no stored table, exactly as UserProfileResponse
// is: every number here is a count over rows that already exist, and a cached
// copy would only introduce a second answer to the same question.
// ---------------------------------------------------------------------------

/**
 * Someone who has worked in this project.
 *
 * Derived, never assigned. Projects hold no members and are not going to
 * (docs/features/11: "organizational only") — a second ACL layer under the
 * workspace boundary would be a new authorization surface for no gain. So the
 * people shown here are the people who have actually revised a page in it,
 * which has the useful property of staying true without anyone maintaining it.
 *
 * Ids only: names and faces come from the workspace-member roster the client
 * already has cached, so this endpoint never re-sends them.
 */
export interface ProjectContributor {
  userId: string;
  /** Distinct pages in this project they have authored a revision of. */
  pageCount: number;
  /** Their most recent revision here. */
  lastActiveAt: string;
}

export interface ProjectOverviewResponse {
  project: ProjectSummary;
  contributors: ProjectContributor[];
  counts: {
    documents: number;
    glossaryTerms: number;
    connectors: number;
    workflows: number;
    openMergeRequests: number;
  };
  /** Most recently updated pages, capped — the rail links out for the rest. */
  recentPages: { documentId: string; title: string; updatedAt: string }[];
}

// ---------------------------------------------------------------------------
// Avatars. The same three-step upload page attachments use, for the same
// reason: the bytes go straight to object storage on a presigned URL, so a
// picture never streams through Node. `POST …/avatar` reserves and answers with
// the URL to PUT to; `POST …/avatar/complete` is what makes it the live face,
// after the API has confirmed the bytes actually arrived.
// ---------------------------------------------------------------------------

/** Image types an avatar may be. Checked at reserve time, before any bytes move. */
export const AVATAR_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

/**
 * 2 MB. Smaller than a page attachment on purpose: this is a face rendered at
 * 28px, and the cost of a large one is paid on every screen that lists people.
 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

// POST /v1/me/avatar · POST /v1/projects/:id/avatar
export interface CreateAvatarUploadRequest {
  filename: string;
  contentType: AvatarContentType;
  sizeBytes: number;
}
export interface CreateAvatarUploadResponse {
  /**
   * Names this attempt. Echoed back on complete, so the API can rebuild the
   * object key it signed rather than trusting a key from the client — the same
   * reason attachments reserve a row before the bytes exist.
   */
  uploadId: string;
  upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string };
}

export interface CompleteAvatarUploadResponse {
  avatarUrl: AvatarUrl;
}

export interface WorkspaceMemberEntry {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: AvatarUrl;
  role: WorkspaceRole;
  trustedOperator: boolean;
  disabled: boolean;
  createdAt: string;
}

// GET /v1/workspaces/:id/members
export interface ListWorkspaceMembersResponse {
  workspaceId: string;
  members: WorkspaceMemberEntry[];
}

/**
 * A user who is *not* yet a member of the workspace — what the add-member
 * picker searches. Deliberately thinner than {@link UserSummary}: workspace
 * admins are not platform admins, so they see identity only, never
 * credentials, the platform-admin flag or foreign memberships.
 */
export interface WorkspaceCandidate {
  userId: string;
  email: string;
  displayName: string;
  /** Disabled accounts cannot authenticate; adding one is legal but inert. */
  disabled: boolean;
}

// GET /v1/workspaces/:id/candidates?q=&limit=
export interface ListWorkspaceCandidatesResponse {
  workspaceId: string;
  candidates: WorkspaceCandidate[];
}

// ---------------------------------------------------------------------------
// User groups (#76): workspace-scoped sets of members that page and project
// restrictions grant to. Membership is manual today; `connector` groups are
// mirrored from a source by ACL sync and `scim` ones by provisioning, and both
// are read-only over the API — a manual edit would be overwritten next sync.

export const GROUP_SOURCES = ['manual', 'connector', 'scim'] as const;
export type GroupSource = (typeof GROUP_SOURCES)[number];

export interface UserGroupSummary {
  groupId: string;
  workspaceId: string;
  name: string;
  description: string | null;
  source: GroupSource;
  memberCount: number;
  createdAt: string;
}

// GET /v1/groups?workspaceId=
export interface ListUserGroupsResponse {
  workspaceId: string;
  groups: UserGroupSummary[];
}

export interface UserGroupMemberEntry {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: AvatarUrl;
  /** The person's workspace role — a guest in a group still reads only what the group is granted. */
  role: WorkspaceRole;
  source: GroupSource;
  createdAt: string;
}

// GET /v1/groups/:id/members · PUT /v1/groups/:id/members
export interface ListUserGroupMembersResponse {
  groupId: string;
  members: UserGroupMemberEntry[];
}

// ---------------------------------------------------------------------------
// Page and project restrictions (#76, phase 2).
//
// A project or page is *restricted* when its own switch is on. A reader must be
// admitted by every restricted node on the chain project → root → … → page, so
// restricting a parent hides its whole subtree and a child can only narrow.
// Grants on an unrestricted node admit nobody new to the workspace's members;
// they are how a guest reaches a page and how edit/manage are handed out.
// The workspace role stays the ceiling: a viewer with an `edit` grant still
// reads only. Workspace admins see and manage everything.

export const ACCESS_LEVELS = ['view', 'edit', 'manage'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
/** What a caller may do with one page or project; `none` = they may not open it. */
export type EffectiveAccessLevel = AccessLevel | 'none';

/** none < view < edit < manage, for comparing two levels without a lookup table at each site. */
export function accessRank(level: EffectiveAccessLevel): number {
  return level === 'none' ? -1 : ACCESS_LEVELS.indexOf(level);
}

export const ACCESS_RESOURCE_TYPES = ['project', 'document'] as const;
export type AccessResourceType = (typeof ACCESS_RESOURCE_TYPES)[number];

export const ACCESS_SUBJECT_TYPES = ['user', 'group'] as const;
export type AccessSubjectType = (typeof ACCESS_SUBJECT_TYPES)[number];

export interface AccessGrantInput {
  subjectType: AccessSubjectType;
  subjectId: string;
  level: AccessLevel;
}

export interface AccessGrantEntry extends AccessGrantInput {
  /** The group's name or the person's display name; null when the subject is gone. */
  name: string | null;
  /** People only. */
  email: string | null;
  avatarUrl: AvatarUrl;
  /** Groups only. */
  memberCount: number | null;
}

/** A restricted node above the one being looked at, which every reader must also pass. */
export interface InheritedRestriction {
  resourceType: AccessResourceType;
  resourceId: string;
  /** Null when the caller may not open that node — a guest's ungranted ancestor. */
  title: string | null;
  grantCount: number;
}

// GET /v1/documents/:id/access · GET /v1/projects/:id/access
export interface ResourceAccessResponse {
  resourceType: AccessResourceType;
  resourceId: string;
  restricted: boolean;
  /** Outermost first: the project, then ancestors root-first. Empty when nothing above is restricted. */
  inherited: InheritedRestriction[];
  /** What the caller may do here. */
  level: EffectiveAccessLevel;
  canManage: boolean;
  /** Grants on this node itself. Empty unless `canManage`: who holds what is a manager's business. */
  grants: AccessGrantEntry[];
}

// PUT /v1/documents/:id/access · PUT /v1/projects/:id/access
export interface UpdateResourceAccessRequest {
  restricted: boolean;
  /** Replaces the node's grants as a whole. */
  grants: AccessGrantInput[];
}

/** Why someone holds the level they do. */
export const EFFECTIVE_ACCESS_SOURCES = ['admin', 'role', 'grant'] as const;
export type EffectiveAccessSource = (typeof EFFECTIVE_ACCESS_SOURCES)[number];

export interface EffectiveAccessEntry {
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: AvatarUrl;
  role: WorkspaceRole;
  level: AccessLevel;
  /** `admin`: workspace admin; `role`: the workspace role decides; `grant`: a user or group grant does. */
  source: EffectiveAccessSource;
}

// GET /v1/documents/:id/access/effective · GET /v1/projects/:id/access/effective
export interface EffectiveAccessResponse {
  resourceType: AccessResourceType;
  resourceId: string;
  /** Everyone who may open it, highest level first. */
  entries: EffectiveAccessEntry[];
}



// ---------------------------------------------------------------------------
// Strict error contract
