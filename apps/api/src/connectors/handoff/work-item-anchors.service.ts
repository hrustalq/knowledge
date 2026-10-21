import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Connector, ConnectorWorkItem } from '@prisma/client';
import { accessRank, workItemRefFooter, type Locale, type WorkItemSourceKind, type WorkItemStatus } from '@knowledge/contracts';
import { ActivityService } from '../../activity/activity.service.js';
import { AccessService } from '../../auth/access.service.js';
import type { Env } from '../../config/env.js';
import { ConflictsService } from '../../conflicts/conflicts.service.js';
import { asLocale } from '../../i18n/locale.js';
import { t } from '../../i18n/t.js';
import { PermissionService } from '../../permissions/permission.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { VerificationService } from '../../verification/verification.service.js';
import type { TrackerBodyLine } from '../adapters/tracker.js';
import { keyOf } from '../connector-work-items.service.js';
import type { AnchorState } from './work-item-sync.js';

const OPEN_ISSUE = ['open', 'checking', 'proposed'];

/** One knowledge object as a handoff sees it. */
export interface AnchorView {
  kind: WorkItemSourceKind;
  id: string;
  workspaceId: string;
  /** The page the ticket is about — what the row's `document_id` is set to. */
  documentId: string;
  /** A conflict's other page, which must be visible too. */
  otherDocumentId: string | null;
  projectId: string;
  /** Whether any page involved is restricted: the ticket then names ids, never titles. */
  restricted: boolean;
  state: AnchorState;
}

/**
 * The anchor side of a handoff (#424): what a ticket says about its object,
 * what state the object is in, and what a tracker close may do to it.
 *
 * Ticket text is written in the connector's frozen locale and is summary only
 * — the object's title, a one-line reason, a link and the `knowledge-ref:`
 * footer. Page content, report text and model explanations never leave: the
 * tracker's readers are not the page's readers.
 */
@Injectable()
export class WorkItemAnchorsService {
  private readonly logger = new Logger(WorkItemAnchorsService.name);
  private readonly webBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly conflicts: ConflictsService,
    private readonly verification: VerificationService,
    private readonly activity: ActivityService,
    private readonly access: AccessService,
    private readonly permissions: PermissionService,
    config: ConfigService<Env, true>,
  ) {
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
  }

  /** The anchor in this workspace, or null when there is none. */
  async describe(workspaceId: string, kind: WorkItemSourceKind, id: string): Promise<AnchorView | null> {
    if (kind === 'issue') {
      const issue = await this.prisma.knowledgeIssue.findFirst({ where: { id, workspaceId } });
      if (!issue) return null;
      const page = await this.page(issue.documentId);
      if (!page) return null;
      return { kind, id, workspaceId, documentId: page.id, otherDocumentId: null, projectId: page.projectId, restricted: page.restricted, state: issueState(issue) };
    }
    if (kind === 'conflict') {
      const conflict = await this.prisma.knowledgeConflict.findFirst({ where: { id, workspaceId } });
      if (!conflict) return null;
      const a = await this.page(conflict.aDocumentId);
      const b = conflict.bDocumentId ? await this.page(conflict.bDocumentId) : null;
      if (!a) return null;
      return {
        kind,
        id,
        workspaceId,
        documentId: a.id,
        otherDocumentId: b?.id ?? null,
        projectId: a.projectId,
        restricted: a.restricted || !!b?.restricted,
        state: conflictState(conflict),
      };
    }
    const page = await this.prisma.document.findFirst({ where: { id, workspaceId } });
    if (!page) return null;
    return {
      kind,
      id,
      workspaceId,
      documentId: page.id,
      otherDocumentId: null,
      projectId: page.projectId,
      restricted: page.restrictedBy.length > 0,
      state:
        kind === 'verification'
          ? verificationState(page, (await this.flagChanges([page.id])).get(page.id))
          : { status: null, at: page.createdAt },
    };
  }

  /** Title and body of a new ticket for this anchor, in the connector's locale. */
  async ticketText(view: AnchorView, locale: Locale): Promise<{ title: string; lines: TrackerBodyLine[] }> {
    const titles = await this.titles([view.documentId, view.otherDocumentId]);
    const a = titles.get(view.documentId) ?? view.documentId;
    const b = view.otherDocumentId ? (titles.get(view.otherDocumentId) ?? view.otherDocumentId) : null;
    const title = view.restricted
      ? t(`connector.workItem.restrictedTitle.${view.kind}`, { id: view.id }, locale)
      : t(`connector.workItem.title.${view.kind}`, { title: b ? `${a} ↔ ${b}` : a }, locale);
    return {
      title: title.slice(0, 250),
      lines: [
        { text: await this.summary(view, locale) },
        { link: this.link(view), text: t('connector.workItem.openLink', {}, locale) },
        { text: workItemRefFooter(view.kind, view.id) },
      ],
    };
  }

  /** Where the deep link points. */
  link(view: Pick<AnchorView, 'kind' | 'documentId'>): string {
    return view.kind === 'conflict' ? `${this.webBaseUrl}/conflicts` : `${this.webBaseUrl}/documents/${view.documentId}`;
  }

  /**
   * Each anchored row's anchor state, batched per kind. A row whose anchor is
   * gone maps to `'missing'`; a `document` anchor has no state to sync.
   */
  async states(rows: ConnectorWorkItem[]): Promise<Map<string, AnchorState | 'missing'>> {
    const out = new Map<string, AnchorState | 'missing'>();
    const ids = (kind: WorkItemSourceKind) =>
      rows.filter((r) => r.sourceKind === kind && r.sourceId).map((r) => r.sourceId as string);
    const [issues, conflicts, pages, changes] = await Promise.all([
      this.prisma.knowledgeIssue.findMany({ where: { id: { in: ids('issue') } } }),
      this.prisma.knowledgeConflict.findMany({ where: { id: { in: ids('conflict') } } }),
      this.prisma.document.findMany({ where: { id: { in: ids('verification') } } }),
      this.flagChanges(ids('verification')),
    ]);
    const byId = new Map<string, AnchorState>([
      ...issues.map((i) => [i.id, issueState(i)] as const),
      ...conflicts.map((c) => [c.id, conflictState(c)] as const),
      ...pages.map((p) => [p.id, verificationState(p, changes.get(p.id))] as const),
    ]);
    for (const row of rows) {
      if (!row.sourceId || row.sourceKind === 'document') continue;
      out.set(row.id, byId.get(row.sourceId) ?? 'missing');
    }
    return out;
  }

  /**
   * The ticket closed in the tracker: resolve its anchor, attributed to the
   * tracker account's person when it maps to one. A flag is cleared only for a
   * mapped person who may edit the page, and a page is never verified — that
   * is a person's act in this product (feature 39). Returns whether it moved.
   */
  async resolve(connector: Connector, row: ConnectorWorkItem, status: 'done' | 'wont_do', actor: string): Promise<boolean> {
    const person = actor.startsWith('tracker:') ? null : actor;
    const via = { workItemId: row.id, key: keyOf(row), url: row.url, via: 'tracker', by: actor };
    if (row.sourceKind === 'issue' && row.sourceId) {
      const next = status === 'done' ? 'resolved' : 'dismissed';
      const { count } = await this.prisma.knowledgeIssue.updateMany({
        where: { id: row.sourceId, status: { in: OPEN_ISSUE } },
        data: { status: next, resolvedBy: person, resolvedAt: new Date() },
      });
      if (count) {
        const issue = await this.prisma.knowledgeIssue.findUniqueOrThrow({ where: { id: row.sourceId } });
        void this.activity.record({
          workspaceId: issue.workspaceId,
          actor,
          action: `knowledge-issue.${next}`,
          documentId: issue.documentId,
          subjectId: issue.id,
          metadata: { title: (await this.titles([issue.documentId])).get(issue.documentId) ?? null, kind: issue.kind, issueId: issue.id, ...via },
        });
      }
      return count > 0;
    }
    if (row.sourceKind === 'conflict' && row.sourceId) {
      const note = t('connector.workItem.closedVia', { key: keyOf(row) }, asLocale(connector.locale));
      return this.conflicts.closeFromTracker(row.sourceId, status === 'done' ? 'resolved' : 'dismissed', person, note);
    }
    if (row.sourceKind === 'verification' && row.sourceId) {
      if (!person || !(await this.mayEdit(person, connector.workspaceId, row.sourceId))) return false;
      return this.verification.clearFlag(row.sourceId, person, via);
    }
    return false;
  }

  // --- internals ---

  /**
   * When each page's flag last went away. A page has no `updated_at`, and a
   * cleared flag leaves no stamp on the row (`clear` wipes the source), so the
   * activity feed — which every verification write records — is the clock.
   */
  private async flagChanges(ids: string[]): Promise<Map<string, Date>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ document_id: string; at: Date }>>`
      SELECT document_id, max(created_at) AS at FROM activity_log
       WHERE document_id = ANY(${ids}::uuid[])
         AND action IN ('document.verified', 'document.verification-cleared', 'document.unverified')
       GROUP BY document_id`;
    return new Map(rows.map((r) => [r.document_id, r.at]));
  }

  /** Whether a mapped person could edit the page themselves — checked on execution, now. */
  private async mayEdit(userId: string, workspaceId: string, documentId: string): Promise<boolean> {
    try {
      const principal = await this.access.principalFor(userId, 'en');
      const scope = await this.permissions.scopeFor(principal, workspaceId);
      if (scope.readOnly || scope.role === 'viewer') return false;
      const level = await this.permissions.levelFor(scope, { type: 'document', id: documentId });
      return accessRank(level) >= accessRank('edit');
    } catch (err) {
      this.logger.debug(`tracker actor ${userId} cannot act here: ${(err as Error).message}`);
      return false;
    }
  }

  private async summary(view: AnchorView, locale: Locale): Promise<string> {
    if (view.kind === 'issue') {
      const issue = await this.prisma.knowledgeIssue.findUnique({ where: { id: view.id }, select: { kind: true } });
      return t('connector.workItem.summary.issue', { kind: issue?.kind ?? 'other' }, locale);
    }
    if (view.kind === 'verification') {
      const page = await this.prisma.document.findUnique({ where: { id: view.id }, select: { verificationFlag: true } });
      const flag = page?.verificationFlag;
      return t(`connector.workItem.summary.${flag === 'outdated' || flag === 'requested' ? flag : 'verification'}`, {}, locale);
    }
    return t(`connector.workItem.summary.${view.kind}`, {}, locale);
  }

  private async page(id: string): Promise<{ id: string; projectId: string; restricted: boolean } | null> {
    const doc = await this.prisma.document.findUnique({ where: { id }, select: { id: true, projectId: true, restrictedBy: true } });
    return doc ? { id: doc.id, projectId: doc.projectId, restricted: doc.restrictedBy.length > 0 } : null;
  }

  private async titles(ids: Array<string | null>): Promise<Map<string, string>> {
    const wanted = ids.filter((id): id is string => Boolean(id));
    const docs = wanted.length
      ? await this.prisma.document.findMany({ where: { id: { in: wanted } }, select: { id: true, title: true } })
      : [];
    return new Map(docs.map((d) => [d.id, d.title]));
  }
}

function issueState(issue: { status: string; resolvedAt: Date | null; createdAt: Date }): AnchorState {
  const status: WorkItemStatus = issue.status === 'resolved' ? 'done' : issue.status === 'dismissed' ? 'wont_do' : 'open';
  return { status, at: issue.resolvedAt ?? issue.createdAt };
}

/** A superseded conflict has no opinion: the arbiter re-detects, and a re-raise reopens it. */
function conflictState(c: { status: string; resolvedAt: Date | null; detectedAt: Date }): AnchorState {
  const status: WorkItemStatus | null =
    c.status === 'open' ? 'open' : c.status === 'resolved' ? 'done' : c.status === 'dismissed' ? 'wont_do' : null;
  return { status, at: c.resolvedAt ?? c.detectedAt };
}

/**
 * A flagged page asks for an open ticket, from the moment it was flagged; an
 * unflagged one for a done ticket, from when the flag last went away.
 */
function verificationState(
  page: { verificationFlag: string | null; verificationSource: unknown; verifiedAt: Date | null; createdAt: Date },
  clearedAt: Date | undefined,
): AnchorState {
  if (page.verificationFlag) {
    const at = Date.parse((page.verificationSource as { at?: string } | null)?.at ?? '');
    return { status: 'open', at: Number.isFinite(at) ? new Date(at) : page.createdAt };
  }
  return { status: 'done', at: clearedAt ?? page.verifiedAt ?? page.createdAt };
}
