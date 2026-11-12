import { UUID_RE, type AgentRunInput } from '@knowledge/contracts';
import type { PrismaService } from '../prisma/prisma.service.js';

type Db = Pick<PrismaService, 'document' | 'mergeRequest' | 'knowledgeIssue' | 'memo' | 'connector'>;

/**
 * The one project an agent run is about (#927), or null: the project of the
 * page(s) it names — by subject (`doc:`, `mr:`, `issue:`) or in its input —
 * else its memo's, else its connector's. A run naming pages of several
 * projects is unattributed, never split or guessed; so is a workspace-wide one.
 *
 * Resolved once, when the run starts (`AgentExecutor.run`), and stamped on
 * `agent_runs.project_id`; every model call of the run inherits it through the
 * run context. The migration's backfill spells the same rules in SQL.
 */
export async function projectOfRun(
  db: Db,
  run: { workspaceId: string; subjectKey: string | null; input: unknown },
): Promise<string | null> {
  const { workspaceId } = run;
  const input = (run.input ?? {}) as AgentRunInput;
  // `doc:<id>` → 'doc' and the id; a webhook delivery or a component draft names no single row.
  const [kind, ...rest] = (run.subjectKey ?? '').split(':');
  const subject = rest.join(':') || null;
  const uuid = (id: string | null | undefined): string | null => (id && UUID_RE.test(id) ? id : null);

  const pages = new Set<string>();
  for (const id of [
    kind === 'doc' ? subject : null,
    input.apiSpecDocumentId,
    input.apiTestSuite?.documentId,
    input.apiFixtureRanking?.documentId,
    ...(input.documentIds ?? []),
  ]) {
    if (uuid(id)) pages.add(id!);
  }
  const mergeRequestId = uuid(kind === 'mr' ? subject : null);
  if (mergeRequestId) {
    const mr = await db.mergeRequest.findUnique({ where: { id: mergeRequestId }, select: { documentId: true } });
    if (mr) pages.add(mr.documentId);
  }
  const issueId = uuid(input.issueId ?? (kind === 'issue' ? subject : null));
  if (issueId) {
    const issue = await db.knowledgeIssue.findFirst({ where: { id: issueId, workspaceId }, select: { documentId: true } });
    if (issue) pages.add(issue.documentId);
  }
  if (pages.size) {
    const rows = await db.document.findMany({ where: { id: { in: [...pages] }, workspaceId }, select: { projectId: true } });
    const projects = new Set(rows.map((r) => r.projectId));
    return projects.size === 1 ? [...projects][0]! : null;
  }

  const memoId = uuid(input.memo?.memoId);
  if (memoId) {
    const memo = await db.memo.findFirst({ where: { id: memoId, workspaceId }, select: { projectId: true } });
    if (memo) return memo.projectId;
  }
  const connectorId = uuid(input.connectorId ?? (kind === 'connector' ? subject : null));
  if (connectorId) {
    const connector = await db.connector.findFirst({ where: { id: connectorId, workspaceId }, select: { projectId: true } });
    if (connector) return connector.projectId;
  }
  return null;
}
