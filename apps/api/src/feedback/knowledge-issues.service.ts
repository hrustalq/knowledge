import { HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { KnowledgeIssue } from '@prisma/client';
import type {
  AgentRunInput,
  KnowledgeIssueEvidence,
  KnowledgeIssueInfo,
  KnowledgeIssueKind,
  KnowledgeIssueStatus,
  KnowledgeIssueSurface,
  ListKnowledgeIssuesResponse,
  ReportKnowledgeIssueResponse,
} from '@knowledge/contracts';
import {
  KNOWLEDGE_ISSUE_EVIDENCE_ITEM_MAX_CHARS,
  KNOWLEDGE_ISSUE_EVIDENCE_MAX,
  KNOWLEDGE_ISSUE_DETAIL_MAX_CHARS,
  KNOWLEDGE_ISSUE_SUGGESTION_MAX_CHARS,
  OPEN_KNOWLEDGE_ISSUE_STATUSES,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { MergeRequestsService } from '../documents/merge-requests.service.js';
import { openDraftMergeRequest } from '../documents/draft-merge-request.js';
import { composeFrontmatter } from '../common/frontmatter.js';
import { AccessService } from '../auth/access.service.js';
import type { Principal } from '../auth/principal.js';
import { DEV_PRINCIPAL } from '../auth/principal.js';
import { ActivityService } from '../activity/activity.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { EventsPublisher } from '../events/events.publisher.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AgentProducer } from '../agents/agent.producer.js';
import { MIN_DRAFT_CHARS } from '../agents/archaeology.js';
import { t } from '../i18n/t.js';

/** The agent a report check runs as — the drift check's sentinel, pointed at a report instead of a diff. */
export const REPORT_AGENT_KEY = 'sentinel';
/** Issues a list returns at most; the rail shows a handful and the tab pages by status. */
const LIST_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReportIssueInput {
  workspaceId: string;
  documentId: string;
  revisionId?: string;
  kind: KnowledgeIssueKind;
  detail: string;
  evidence?: KnowledgeIssueEvidence[];
  suggestedMarkdown?: string;
  surface: KnowledgeIssueSurface;
}

/**
 * Reported problems with a page (docs/features/38, issue #67 phase 3).
 *
 * A report is filed by anyone who may read the page and routed, API-side where
 * a principal exists, to the cheapest thing that can act on it:
 *
 * - **a draft merge request**, at once, when the reporter supplied a corrected
 *   body and holds `editor` — checked here, on execution, not at the form;
 * - **a sentinel run**, when the agent is on and the workspace is under its
 *   cap of waiting checks: the run judges the report against the page and
 *   drafts the fix, and `ReportPublishSweeper` opens the merge request;
 * - **nothing**, otherwise: the issue stays `open` in the page's rail for a
 *   person.
 *
 * One open issue per (page, kind): a second report folds in as `reportCount`
 * and more evidence rather than a second row. That is a partial unique index
 * Prisma cannot express, so it is a guarded UPDATE-then-INSERT — a race writes
 * two rows at worst, and the read side tolerates that.
 *
 * Controller-free but **API-side only**: opening a merge request needs
 * `MergeRequestsService`, which deliberately never loads in the worker. The
 * worker reads `knowledge_issues` through Prisma (the sentinel's `checkReport`,
 * the provenance count) and never through this service.
 */
@Injectable()
export class KnowledgeIssuesService {
  private readonly logger = new Logger(KnowledgeIssuesService.name);

  constructor(
    readonly prisma: PrismaService,
    readonly storage: StorageService,
    readonly documents: DocumentsService,
    readonly mergeRequests: MergeRequestsService,
    private readonly access: AccessService,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationsService,
    private readonly events: EventsPublisher,
    private readonly registry: AgentRegistryService,
    private readonly producer: AgentProducer,
    private readonly env: ConfigService,
  ) {}

  private get dailyLimit(): number {
    return this.env.get<number>('KNOWLEDGE_ISSUE_DAILY_LIMIT') ?? 50;
  }
  private get maxPendingChecks(): number {
    return this.env.get<number>('KNOWLEDGE_ISSUE_MAX_PENDING_CHECKS') ?? 10;
  }

  /** File a report, folding it into an open issue for the same page and kind when one exists. */
  async report(input: ReportIssueInput, principal: Principal): Promise<ReportKnowledgeIssueResponse> {
    const document = await this.prisma.document.findUnique({
      where: { id: input.documentId },
      select: { id: true, workspaceId: true, title: true, defaultBranch: true, branches: { select: { name: true, headRevisionId: true } } },
    });
    // A document from another tenant reads as absent: the guard checked the
    // body's workspace, and the page must belong to that same workspace.
    if (!document || document.workspaceId !== input.workspaceId) {
      throw new NotFoundException(t('error.document.notFound', { id: input.documentId }));
    }
    await this.assertUnderDailyLimit(principal);

    const detail = input.detail.trim().slice(0, KNOWLEDGE_ISSUE_DETAIL_MAX_CHARS);
    const evidence = normalizeEvidence(input.evidence ?? []);
    const suggestion = input.suggestedMarkdown?.trim().slice(0, KNOWLEDGE_ISSUE_SUGGESTION_MAX_CHARS) || null;

    const folded = await this.foldInto(document.id, input.kind, evidence);
    if (folded) {
      return { issue: toInfo(folded, document.title), deduplicated: true };
    }
    const created = await this.insertGuarded({
      workspaceId: document.workspaceId,
      documentId: document.id,
      revisionId: input.revisionId ?? null,
      kind: input.kind,
      detail,
      evidence,
      suggestedMarkdown: suggestion,
      surface: input.surface,
      createdBy: principal.userId,
      apiKeyId: principal.apiKey?.id ?? null,
    });
    if (!created) {
      // Lost the race to another report of the same page and kind: fold into
      // the row that won. A second miss here is the duplicate the read side
      // tolerates, so one retry is all that is honest to try.
      const again = await this.foldInto(document.id, input.kind, evidence);
      if (again) return { issue: toInfo(again, document.title), deduplicated: true };
      throw new HttpException({ statusCode: 409, message: t('error.knowledgeIssue.raced') }, HttpStatus.CONFLICT);
    }

    void this.activity.record({
      workspaceId: document.workspaceId,
      actor: principal.userId,
      action: 'knowledge-issue.reported',
      documentId: document.id,
      subjectId: created.id,
      metadata: { title: document.title, kind: input.kind, issueId: created.id, surface: input.surface },
    });
    void this.notifyAuthor(document, created, principal);

    const routed = await this.route(created, document, suggestion, principal);
    return { issue: toInfo(routed, document.title), deduplicated: false };
  }

  /**
   * Where the report goes. A corrected body from an editor becomes a merge
   * request now; anything else is handed to the sentinel when it can take it,
   * and stays open for a person when it cannot. Every branch is a guarded
   * write on the issue still being `open`, so a sweeper or a second request
   * that moved it first wins.
   */
  private async route(
    issue: KnowledgeIssue,
    document: { id: string; workspaceId: string; title: string },
    suggestion: string | null,
    principal: Principal,
  ): Promise<KnowledgeIssue> {
    if (suggestion && (await this.canEdit(principal, document.workspaceId))) {
      const proposed = await this.proposeSuggestion(issue, document, suggestion, principal).catch((error: unknown) => {
        this.logger.warn(`Draft from report ${issue.id} not opened: ${(error as Error).message}`);
        return null;
      });
      if (proposed) return proposed;
    }

    const runId = await this.queueCheck(issue, principal).catch((error: unknown) => {
      this.logger.warn(`Sentinel check for report ${issue.id} not queued: ${(error as Error).message}`);
      return null;
    });
    if (runId) {
      const moved = await this.prisma.knowledgeIssue.updateMany({
        where: { id: issue.id, status: 'open' },
        data: { status: 'checking', agentRunId: runId },
      });
      if (moved.count === 1) return { ...issue, status: 'checking', agentRunId: runId };
    }
    return issue;
  }

  /**
   * An editor's corrected page, published as-is (docs/features/35 — "Propose
   * publishes it as-is"), with the page's frontmatter put back: the reporter
   * wrote a body, and the revision is the whole file. A body too short to be a
   * page, or identical to the one standing, is not a fix: the report falls
   * through to the sentinel instead.
   */
  private async proposeSuggestion(
    issue: KnowledgeIssue,
    document: { id: string; workspaceId: string; title: string },
    suggestion: string,
    principal: Principal,
  ): Promise<KnowledgeIssue | null> {
    const current = await this.documents.getContent(document.id).catch(() => null);
    if (suggestion.length < MIN_DRAFT_CHARS || suggestion === current?.markdown.trim()) return null;

    const branch = `report/${issue.id.slice(0, 8)}-${Date.now()}`;
    const mergeRequestId = await openDraftMergeRequest(this, {
      documentId: document.id,
      branch,
      title: t('knowledgeIssue.mergeRequestTitle', { title: document.title, kind: t(`knowledgeIssue.kind.${issue.kind}`) }).slice(0, 200),
      description: `${t('knowledgeIssue.mergeRequestIntro', { kind: t(`knowledgeIssue.kind.${issue.kind}`) })}\n\n${issue.detail}`,
      markdown: composeFrontmatter(suggestion, current?.frontmatter ?? {}),
      userId: principal.userId,
      onCreated: async (id) => {
        const moved = await this.prisma.knowledgeIssue.updateMany({
          where: { id: issue.id, status: 'open' },
          data: { status: 'proposed', mergeRequestId: id },
        });
        if (moved.count !== 1) throw new Error(`issue ${issue.id} is no longer open`);
      },
    });
    void this.activity.record({
      workspaceId: document.workspaceId,
      actor: principal.userId,
      action: 'knowledge-issue.proposed',
      documentId: document.id,
      subjectId: issue.id,
      metadata: { title: document.title, kind: issue.kind, issueId: issue.id, mergeRequestId },
    });
    return { ...issue, status: 'proposed', mergeRequestId };
  }

  /**
   * A sentinel run for the report, owned by the reporter — their role caps the
   * run's tools and their budget pays for it, the way a connector's owner pays
   * for a drift check. The dev stub owns its own runs: `principalFor` accepts
   * it, so nobody else's authority is borrowed.
   */
  private async queueCheck(issue: KnowledgeIssue, principal: Principal): Promise<string | null> {
    const agent = await this.registry.resolve(issue.workspaceId, REPORT_AGENT_KEY);
    if (!agent.enabled || !agent.config.enabled) return null;
    // Report checks only: drift checks share the agent and have their own cap.
    const [{ pending }] = await this.prisma.$queryRaw<Array<{ pending: number }>>`
      SELECT count(*)::int AS pending FROM agent_runs
       WHERE workspace_id = ${issue.workspaceId}::uuid
         AND agent_key = ${REPORT_AGENT_KEY}
         AND status = 'pending'
         AND COALESCE(input ->> 'issueId', '') <> ''
    `;
    if (pending >= this.maxPendingChecks) return null;

    const override = await this.prisma.aiAgent.findUnique({
      where: { workspaceId_key: { workspaceId: issue.workspaceId, key: REPORT_AGENT_KEY } },
      select: { id: true },
    });
    const input: AgentRunInput = { issueId: issue.id };
    const run = await this.prisma.agentRun.create({
      data: {
        workspaceId: issue.workspaceId,
        agentKey: REPORT_AGENT_KEY,
        agentId: override?.id ?? null,
        trigger: 'report',
        createdBy: principal.userId,
        locale: principal.locale,
        input: input as unknown as Prisma.InputJsonValue,
      },
    });
    await this.producer.enqueue(run.id);
    return run.id;
  }

  /** Issues of a workspace, newest first; narrowed to one page or one status. */
  async list(workspaceId: string, filter: { documentId?: string; status?: KnowledgeIssueStatus }): Promise<ListKnowledgeIssuesResponse> {
    const rows = await this.prisma.knowledgeIssue.findMany({
      where: {
        workspaceId,
        ...(filter.documentId ? { documentId: filter.documentId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIST_LIMIT,
    });
    const titles = await this.titlesFor(rows.map((r) => r.documentId));
    return { workspaceId, issues: rows.map((r) => toInfo(r, titles.get(r.documentId) ?? null)) };
  }

  /** Close an issue by hand. Both end states are final; closing a closed issue just restates it. */
  async close(issueId: string, status: 'resolved' | 'dismissed', principal: Principal): Promise<KnowledgeIssueInfo> {
    const issue = await this.prisma.knowledgeIssue.findUnique({ where: { id: issueId } });
    if (!issue) throw new NotFoundException(t('error.knowledgeIssue.notFound', { id: issueId }));
    const row = await this.prisma.knowledgeIssue.update({
      where: { id: issueId },
      data: { status, resolvedBy: principal.userId, resolvedAt: new Date() },
    });
    const title = (await this.titlesFor([row.documentId])).get(row.documentId) ?? null;
    void this.activity.record({
      workspaceId: row.workspaceId,
      actor: principal.userId,
      action: `knowledge-issue.${status}`,
      documentId: row.documentId,
      subjectId: row.id,
      metadata: { title, kind: row.kind, issueId: row.id },
    });
    return toInfo(row, title);
  }

  // ---- what the publisher needs ---------------------------------------------

  /** The issue a sentinel run was about, or null when it has gone. Used by the sweeper only. */
  async forRun(issueId: string, workspaceId: string): Promise<KnowledgeIssue | null> {
    return this.prisma.knowledgeIssue.findFirst({ where: { id: issueId, workspaceId } });
  }

  /**
   * Record what the sentinel decided. Guarded on the issue still being
   * `checking` — a person who resolved it while the run was out keeps their
   * word over the model's. The verdict is kept as evidence either way, so the
   * rail can show why.
   */
  async settleCheck(
    issueId: string,
    verdict: { status: 'open' | 'proposed' | 'resolved'; note: string; mergeRequestId?: string | null; resolvedBy?: string },
  ): Promise<boolean> {
    const issue = await this.prisma.knowledgeIssue.findUnique({ where: { id: issueId } });
    if (!issue || issue.status !== 'checking') return false;
    const evidence = normalizeEvidence([...readEvidence(issue.evidence), { note: verdict.note }]);
    const moved = await this.prisma.knowledgeIssue.updateMany({
      where: { id: issueId, status: 'checking' },
      data: {
        status: verdict.status,
        evidence: evidence as unknown as Prisma.InputJsonValue,
        ...(verdict.mergeRequestId ? { mergeRequestId: verdict.mergeRequestId } : {}),
        ...(verdict.status === 'resolved'
          ? { resolvedBy: verdict.resolvedBy ?? null, resolvedAt: new Date() }
          : {}),
      },
    });
    if (moved.count === 1 && verdict.status !== 'open') {
      void this.activity.record({
        workspaceId: issue.workspaceId,
        actor: verdict.resolvedBy ?? DEV_PRINCIPAL.userId,
        action: `knowledge-issue.${verdict.status}`,
        documentId: issue.documentId,
        subjectId: issue.id,
        metadata: { kind: issue.kind, issueId: issue.id, ...(verdict.mergeRequestId ? { mergeRequestId: verdict.mergeRequestId } : {}), bySentinel: true },
      });
    }
    return moved.count === 1;
  }

  // ---- internals ------------------------------------------------------------

  private async canEdit(principal: Principal, workspaceId: string): Promise<boolean> {
    try {
      await this.access.requireRole(principal, workspaceId, 'editor');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reports per principal per 24 h. Counted per API key when the request
   * carries one — a person's own reports and their agent's are two budgets.
   * Flat-extras 429: `limit` is what the client should tell the reporter.
   */
  private async assertUnderDailyLimit(principal: Principal): Promise<void> {
    const limit = this.dailyLimit;
    const filed = await this.prisma.knowledgeIssue.count({
      where: {
        createdBy: principal.userId,
        apiKeyId: principal.apiKey?.id ?? null,
        createdAt: { gte: new Date(Date.now() - DAY_MS) },
      },
    });
    if (filed >= limit) {
      throw new HttpException(
        { statusCode: 429, message: t('error.knowledgeIssue.rateLimited', { limit }), limit },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Fold a report into the open issue for the same page and kind: one more
   * report, its evidence appended and capped. One statement, so two reports
   * arriving together both fold rather than one of them opening a second row.
   */
  private async foldInto(documentId: string, kind: string, evidence: KnowledgeIssueEvidence[]): Promise<KnowledgeIssue | null> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE knowledge_issues
         SET report_count = report_count + 1,
             evidence = COALESCE((
               SELECT jsonb_agg(e)
                 FROM (
                   SELECT e FROM jsonb_array_elements(evidence || ${JSON.stringify(evidence)}::jsonb) AS e
                   LIMIT ${KNOWLEDGE_ISSUE_EVIDENCE_MAX}
                 ) capped
             ), '[]'::jsonb),
             updated_at = now()
       WHERE document_id = ${documentId}::uuid
         AND kind = ${kind}
         AND status IN (${Prisma.join([...OPEN_KNOWLEDGE_ISSUE_STATUSES])})
       RETURNING id
    `;
    const id = rows[0]?.id;
    return id ? this.prisma.knowledgeIssue.findUnique({ where: { id } }) : null;
  }

  /** Insert only while no open issue exists for the page and kind — the other half of the partial unique index. */
  private async insertGuarded(data: {
    workspaceId: string;
    documentId: string;
    revisionId: string | null;
    kind: string;
    detail: string;
    evidence: KnowledgeIssueEvidence[];
    suggestedMarkdown: string | null;
    surface: string;
    createdBy: string;
    apiKeyId: string | null;
  }): Promise<KnowledgeIssue | null> {
    const id = randomUUID();
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO knowledge_issues
        (id, workspace_id, document_id, revision_id, kind, status, detail, evidence, suggested_markdown, surface,
         report_count, created_by, api_key_id, created_at, updated_at)
      SELECT ${id}::uuid, ${data.workspaceId}::uuid, ${data.documentId}::uuid, ${data.revisionId}::uuid, ${data.kind}, 'open',
             ${data.detail}, ${JSON.stringify(data.evidence)}::jsonb, ${data.suggestedMarkdown}, ${data.surface},
             1, ${data.createdBy}::uuid, ${data.apiKeyId}::uuid, now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM knowledge_issues
          WHERE document_id = ${data.documentId}::uuid
            AND kind = ${data.kind}
            AND status IN (${Prisma.join([...OPEN_KNOWLEDGE_ISSUE_STATUSES])})
       )
      RETURNING id
    `;
    return rows[0] ? this.prisma.knowledgeIssue.findUnique({ where: { id: rows[0].id } }) : null;
  }

  /**
   * The page's last author hears about a report on it (feature 22, directed,
   * reason `author`). Not the reporter themselves, and nobody for the dev
   * stub, which has no inbox. Fire-and-forget: a notification is a courtesy.
   */
  private async notifyAuthor(
    document: { id: string; workspaceId: string; title: string; defaultBranch: string; branches: Array<{ name: string; headRevisionId: string | null }> },
    issue: KnowledgeIssue,
    principal: Principal,
  ): Promise<void> {
    try {
      const headId = document.branches.find((b) => b.name === document.defaultBranch)?.headRevisionId ?? null;
      if (!headId) return;
      const head = await this.prisma.documentRevision.findUnique({ where: { id: headId }, select: { authorId: true } });
      const author = head?.authorId;
      if (!author || author === principal.userId || author === DEV_PRINCIPAL.userId) return;
      const delivered = await this.notifications.notify({
        workspaceId: document.workspaceId,
        userIds: [author],
        type: 'knowledge-issue.reported',
        reason: 'author',
        actor: principal.userId,
        documentId: document.id,
        subjectType: 'document',
        subjectId: document.id,
        title: document.title,
        metadata: { kind: issue.kind, issueId: issue.id },
      });
      await this.events.announce(document.workspaceId, delivered);
    } catch (error) {
      this.logger.warn(`Report notification not sent (non-fatal): ${(error as Error).message}`);
    }
  }

  private async titlesFor(documentIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(documentIds)];
    if (ids.length === 0) return new Map();
    const docs = await this.prisma.document.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } });
    return new Map(docs.map((d) => [d.id, d.title]));
  }
}

/** Trim, drop empties, cap each field and the list — the same shape whether a person, an agent or the sentinel wrote it. */
export function normalizeEvidence(items: readonly KnowledgeIssueEvidence[]): KnowledgeIssueEvidence[] {
  const out: KnowledgeIssueEvidence[] = [];
  for (const item of items) {
    const quote = item.quote?.trim().slice(0, KNOWLEDGE_ISSUE_EVIDENCE_ITEM_MAX_CHARS);
    const url = item.url?.trim().slice(0, KNOWLEDGE_ISSUE_EVIDENCE_ITEM_MAX_CHARS);
    const note = item.note?.trim().slice(0, KNOWLEDGE_ISSUE_EVIDENCE_ITEM_MAX_CHARS);
    if (!quote && !url && !note) continue;
    out.push({ ...(quote ? { quote } : {}), ...(url ? { url } : {}), ...(note ? { note } : {}) });
    if (out.length >= KNOWLEDGE_ISSUE_EVIDENCE_MAX) break;
  }
  return out;
}

export function readEvidence(value: unknown): KnowledgeIssueEvidence[] {
  return Array.isArray(value) ? (value as KnowledgeIssueEvidence[]) : [];
}

export function toInfo(row: KnowledgeIssue, documentTitle: string | null): KnowledgeIssueInfo {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    documentTitle,
    revisionId: row.revisionId,
    kind: row.kind as KnowledgeIssueKind,
    status: row.status as KnowledgeIssueStatus,
    detail: row.detail,
    evidence: readEvidence(row.evidence),
    hasSuggestion: !!row.suggestedMarkdown,
    surface: row.surface as KnowledgeIssueSurface,
    reportCount: row.reportCount,
    agentRunId: row.agentRunId,
    mergeRequestId: row.mergeRequestId,
    createdBy: row.createdBy,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
