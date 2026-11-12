import type { PrismaService } from '../prisma/prisma.service.js';

type Find = (db: PrismaService, id: string | number) => PromiseLike<string | null | undefined>;

interface SourceRow {
  /** The path param that carries the id. Default `id`. */
  param?: 'runId' | 'filterId';
  /** A positive integer id rather than a uuid (saved filters are shown and linked as `#7`). */
  int?: true;
  /** `subject.*` catalogue key for the invalid-id 400 — translated, not glued in as English. */
  subject: string;
  /** The 404 message key, and the placeholder the id fills (default `id`; extra args are ignored). */
  missing: string;
  arg?: 'ref' | 'key';
  find: Find;
}

type OwnDelegate = {
  findUnique(args: { where: { id: string }; select: { workspaceId: true } }): PromiseLike<{ workspaceId: string } | null>;
};

/** A row that carries its own `workspace_id` column. */
const own =
  (pick: (db: PrismaService) => OwnDelegate): Find =>
  (db, id) =>
    pick(db)
      .findUnique({ where: { id: String(id) }, select: { workspaceId: true } })
      .then((row) => row?.workspaceId);

/**
 * Every `@Access` source that names a row by a path param, and how PostgreSQL
 * finds the workspace that row belongs to. The ACL comes from the row, never
 * a caller-supplied `?workspaceId=`: that is what makes a cross-tenant id 403
 * before the handler runs — for a skill, a template or a chat bot alike.
 *
 * A new resource is one row here; `AclGuard` and `AccessService.workspaceOf`
 * need no change. A row reached through a parent says so in its `find`.
 */
const ROWS = {
  document: { subject: 'document', missing: 'error.document.notFound', find: own((db) => db.document) },
  'merge-request': {
    subject: 'mergeRequest',
    missing: 'error.mergeRequest.notFound',
    find: (db, id) =>
      db.mergeRequest
        .findUnique({ where: { id: String(id) }, select: { document: { select: { workspaceId: true } } } })
        .then((row) => row?.document.workspaceId),
  },
  project: { subject: 'project', missing: 'error.project.notFound', find: own((db) => db.project) },
  job: { subject: 'job', missing: 'error.ingestionJob.notFound', find: own((db) => db.ingestionJob) },
  'assistant-thread': { subject: 'assistantThread', missing: 'error.assistant.threadNotFound', find: own((db) => db.assistantThread) },
  // Through its thread (docs/features/38).
  'assistant-message': {
    subject: 'assistantMessage',
    missing: 'error.assistant.messageNotFoundById',
    find: (db, id) =>
      db.assistantMessage
        .findUnique({ where: { id: String(id) }, select: { thread: { select: { workspaceId: true } } } })
        .then((row) => row?.thread.workspaceId),
  },
  'knowledge-issue': { subject: 'knowledgeIssue', missing: 'error.knowledgeIssue.notFound', find: own((db) => db.knowledgeIssue) },
  'ai-skill': { subject: 'skill', missing: 'error.ai.skillNotFound', find: own((db) => db.aiSkill) },
  'ai-plugin': { subject: 'plugin', missing: 'error.ai.pluginNotFound', find: own((db) => db.aiPlugin) },
  'ai-provider': { subject: 'provider', missing: 'error.ai.providerNotFound', find: own((db) => db.aiProvider) },
  'ai-model': { subject: 'model', missing: 'error.ai.modelNotFound', find: own((db) => db.aiModel) },
  'agent-trigger': { subject: 'agentTrigger', missing: 'error.ai.agentTriggerNotFound', find: own((db) => db.agentTrigger) },
  'agent-learning': { subject: 'agentLearning', missing: 'error.ai.agentLearningNotFound', find: own((db) => db.agentLearning) },
  'glossary-term': { subject: 'glossaryTerm', missing: 'error.glossary.notFound', find: own((db) => db.glossaryTerm) },
  'source-policy': { subject: 'sourcePolicy', missing: 'error.web.notFound', find: own((db) => db.sourcePolicy) },
  // Private to their owner, which the service checks — the guard resolves workspaces, not rows.
  'saved-filter': {
    param: 'filterId',
    int: true,
    subject: 'savedFilter',
    missing: 'error.savedFilter.notFound',
    find: (db, id) => db.savedFilter.findUnique({ where: { id: Number(id) }, select: { workspaceId: true } }).then((row) => row?.workspaceId),
  },
  // Exists before any document does: the only thing between one tenant's import id and another's staged file.
  import: { subject: 'import', missing: 'error.import.notFound', find: own((db) => db.importJob) },
  // Only the workspace: whether the caller uploaded it is the service's question (#551).
  memo: { subject: 'memo', missing: 'error.memo.notFound', find: own((db) => db.memo) },
  // Only the workspace: a bank bound to a hidden project is MemoryWebService's 404 (#994).
  'memory-bank': { subject: 'memoryBank', missing: 'error.memory.bankRowNotFound', find: own((db) => db.memoryBank) },
  'workflow-definition': { subject: 'workflow', missing: 'error.workflow.notFound', find: own((db) => db.workflowDefinition) },
  'workflow-run': { subject: 'workflowRun', missing: 'error.workflow.runNotFound', find: own((db) => db.workflowRun) },
  template: { subject: 'template', missing: 'error.template.notFound', arg: 'ref', find: own((db) => db.pageTemplate) },
  blueprint: { subject: 'blueprint', missing: 'error.blueprint.notFound', arg: 'key', find: own((db) => db.projectBlueprint) },
  'share-link': { subject: 'shareLink', missing: 'error.share.notFound', find: own((db) => db.shareLink) },
  site: { subject: 'site', missing: 'error.site.notFound', find: own((db) => db.publishedSite) },
  'site-version': {
    subject: 'siteVersion',
    missing: 'error.site.versionNotFound',
    find: (db, id) =>
      db.siteVersion
        .findUnique({ where: { id: String(id) }, select: { site: { select: { workspaceId: true } } } })
        .then((row) => row?.site.workspaceId),
  },
  'site-domain': {
    subject: 'siteDomain',
    missing: 'error.site.domainNotFound',
    find: (db, id) =>
      db.siteDomain
        .findUnique({ where: { id: String(id) }, select: { site: { select: { workspaceId: true } } } })
        .then((row) => row?.site.workspaceId),
  },
  export: { subject: 'export', missing: 'error.export.notFound', find: own((db) => db.exportJob) },
  connector: { subject: 'connector', missing: 'error.connector.notFound', find: own((db) => db.connector) },
  'connector-run': { param: 'runId', subject: 'connectorRun', missing: 'error.connector.runNotFound', find: own((db) => db.connectorRun) },
  connection: { subject: 'connection', missing: 'error.connection.notFound', find: own((db) => db.connection) },
  'chat-integration': { subject: 'chatIntegration', missing: 'error.chat.integrationNotFound', find: own((db) => db.chatIntegration) },
  'chat-binding': { subject: 'chatBinding', missing: 'error.chat.bindingNotFound', find: own((db) => db.chatChannelBinding) },
  'chat-subscription': { subject: 'chatSubscription', missing: 'error.chat.subscriptionNotFound', find: own((db) => db.chatSubscription) },
  group: { subject: 'group', missing: 'error.group.notFound', find: own((db) => db.userGroup) },
  'access-request': { subject: 'accessRequest', missing: 'error.access.requestNotFound', find: own((db) => db.accessRequest) },
  capture: { subject: 'capture', missing: 'error.capture.notFound', find: own((db) => db.knowledgeCapture) },
  'release-tag': { subject: 'releaseTag', missing: 'error.releaseTag.notFound', find: own((db) => db.releaseTag) },
  conflict: { subject: 'conflict', missing: 'error.conflict.notFound', find: own((db) => db.knowledgeConflict) },
} satisfies Record<string, SourceRow>;

/** A source whose workspace is read off a row named by a path param. */
export type RowSource = keyof typeof ROWS;

export const WORKSPACE_SOURCES: Record<RowSource, SourceRow> = ROWS;

/** The workspace a row belongs to, or null when there is no such row. */
export async function workspaceOwnerOf(db: PrismaService, source: RowSource, id: string | number): Promise<string | null> {
  return (await WORKSPACE_SOURCES[source].find(db, id)) ?? null;
}
