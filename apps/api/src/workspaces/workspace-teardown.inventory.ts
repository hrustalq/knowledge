import type { Prisma } from '@prisma/client';

/**
 * What happens to each table when a workspace is deleted (#479).
 *
 * - `workspace` — carries `workspace_id`; deleted by it. **Key order is
 *   deletion order** (children before the parents their FKs RESTRICT on).
 * - `audit` — carries `workspace_id`; kept on purpose, so the record of what
 *   happened outlives the workspace it happened in.
 * - `page` — goes with its document in `ProjectCascadeService.cascadeDocuments`.
 * - `parent` — no `workspace_id`; leaves with a workspace-owned parent row,
 *   through an `ON DELETE CASCADE` FK (`assistant_messages` is the one without
 *   one, and is deleted explicitly by thread).
 * - `platform` — not owned by any workspace.
 *
 * Every Prisma model is listed — `workspace-teardown.inventory.spec.ts` fails
 * when one is not, or when a `workspace_id` table is filed anywhere but
 * `workspace` / `audit` / `page` — so a new table cannot silently survive a
 * deletion.
 */
export const WORKSPACE_TEARDOWN = {
  // Rows that hang off pages, swept by workspace in case a page was already
  // gone without them (connector revert, an older cascade).
  MergeRequestCheck: 'workspace',
  IngestionJob: 'workspace',
  Attachment: 'workspace',
  ShareLink: 'workspace',
  GlossaryExclusion: 'workspace',
  RevisionEmbed: 'workspace',
  PageLink: 'workspace',
  ConnectorLink: 'workspace',
  ConnectorConflict: 'workspace',
  Notification: 'workspace',
  NotificationSubscription: 'workspace',
  NotificationPreference: 'workspace',
  AccessGrant: 'workspace',
  AccessRequest: 'workspace',
  CollabDraft: 'workspace',
  ComponentDeclaration: 'workspace',
  ApiOperation: 'workspace',
  ApiFixtureCall: 'workspace',
  ApiTestBinding: 'workspace',
  ApiTestRun: 'workspace',
  ApiTestSuite: 'workspace',
  ApiTestEnvironment: 'workspace',
  DocumentQualityScore: 'workspace',
  // Messages first (explicitly, by thread), then the threads.
  AssistantThread: 'workspace',
  // Runs RESTRICT their definition; nodes cascade from the run.
  WorkflowRun: 'workspace',
  WorkflowDefinition: 'workspace',
  // Connector children (all cascade, listed for the ones that outlive a connector row).
  ConnectorRun: 'workspace',
  ConnectorWorkItem: 'workspace',
  ConnectorHarvest: 'workspace',
  ExternalIdentity: 'workspace',
  CodeImport: 'workspace',
  CodeFile: 'workspace',
  SourceRecipe: 'workspace',
  ProjectTrackerRoute: 'workspace',
  Connector: 'workspace',
  // RESTRICTed by connectors.connection_id, so after them.
  Connection: 'workspace',
  GithubInstallation: 'workspace',
  // Chat, leaves to root.
  ChatMessage: 'workspace',
  ChatChunk: 'workspace',
  ChatSubscription: 'workspace',
  ChatChannelBinding: 'workspace',
  ChatIdentity: 'workspace',
  ChatConversation: 'workspace',
  ChatAnswer: 'workspace',
  ChatIntegration: 'workspace',
  // Sites (domains, versions, pages and audience rules cascade).
  PublishedSite: 'workspace',
  PublishingSettings: 'workspace',
  // Sign-in and provisioning (identities and auth requests cascade from the provider).
  IdpGroupMapping: 'workspace',
  SsoDomain: 'workspace',
  IdentityProvider: 'workspace',
  ScimUser: 'workspace',
  ScimGroup: 'workspace',
  ScimToken: 'workspace',
  UserGroup: 'workspace',
  ApiKey: 'workspace',
  // Projects, once every table that RESTRICTs on them is empty.
  GlossaryTerm: 'workspace',
  // Cascades from its project too; deleted first so the project row is light.
  ProjectCommit: 'workspace',
  // Page branches point at it with SET NULL, and the pages are gone by now.
  ProjectBranch: 'workspace',
  Project: 'workspace',
  // No FK in either direction.
  ActivityLog: 'workspace',
  AgentLearning: 'workspace',
  AgentRun: 'workspace',
  AgentTrigger: 'workspace',
  AiAgent: 'workspace',
  AiPlugin: 'workspace',
  AiProvider: 'workspace',
  AiSettings: 'workspace',
  AiSkill: 'workspace',
  AiUsage: 'workspace',
  AiUserBudget: 'workspace',
  AnswerFeedback: 'workspace',
  EmbedFile: 'workspace',
  EmbedNode: 'workspace',
  EmbedNodeHead: 'workspace',
  EntityAlias: 'workspace',
  ExportJob: 'workspace',
  ImportJob: 'workspace',
  Memo: 'workspace',
  KnowledgeCapture: 'workspace',
  KnowledgeConflict: 'workspace',
  KnowledgeHealthSettings: 'workspace',
  KnowledgeIssue: 'workspace',
  McpToolCall: 'workspace',
  OpsEvent: 'workspace',
  PageTemplate: 'workspace',
  PageView: 'workspace',
  ReleaseTag: 'workspace',
  SavedFilter: 'workspace',
  SearchQuery: 'workspace',
  SourcePolicy: 'workspace',
  WorkspaceSettings: 'workspace',
  // RESTRICTs the workspaces row, which goes last of all.
  WorkspaceMember: 'workspace',

  AuditLog: 'audit',

  Document: 'page',
  DocumentBranch: 'page',
  DocumentRevision: 'page',
  DocumentThread: 'page',
  DocumentComment: 'page',
  RevisionParent: 'page',
  RevisionDiff: 'page',
  MergeRequest: 'page',
  MergeRequestThread: 'page',
  MergeRequestComment: 'page',
  MergeRequestReviewer: 'page',
  SiteVersionPage: 'page',

  AssistantMessage: 'parent',
  ProjectCommitParent: 'parent',
  ProjectCommitChange: 'parent',
  WorkflowRunNode: 'parent',
  ConnectorRunItem: 'parent',
  ChatBufferedMessage: 'parent',
  ChatHarvestMark: 'parent',
  ChatLinkCode: 'parent',
  SiteDomain: 'parent',
  SiteVersion: 'parent',
  SiteAudienceRule: 'parent',
  UserIdentity: 'parent',
  SsoAuthRequest: 'parent',
  ScimGroupMember: 'parent',
  UserGroupMember: 'parent',
  PageTemplateVersion: 'parent',

  Workspace: 'platform',
  User: 'platform',
  Session: 'platform',
  PasswordResetToken: 'platform',
  EmailVerificationToken: 'platform',
  GithubUserToken: 'platform',
  // Referenced from connectors' config, pruned by `pruneFigmaGrants` once none does.
  FigmaOauthGrant: 'platform',
} as const satisfies Record<Prisma.ModelName, 'workspace' | 'audit' | 'page' | 'parent' | 'platform'>;

/** The `workspace` models in deletion order. */
export const WORKSPACE_ROWS = (Object.keys(WORKSPACE_TEARDOWN) as Prisma.ModelName[]).filter(
  (m) => WORKSPACE_TEARDOWN[m] === 'workspace',
);
