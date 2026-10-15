import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ActivityLog, ChatChannelBinding, ChatIntegration, ChatSubscription, Prisma } from '@prisma/client';
import {
  chatActionsFor,
  chatEventKindFor,
  isLocale,
  normalizeEntityKey,
  type ChatDigestMinutes,
  type ChatSubscriptionDelivery,
  type ChatSubscriptionEntry,
  type ChatSubscriptionEventKind,
  type Locale,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GraphService } from '../graph/graph.service.js';
import { t } from '../i18n/t.js';
import { ChatAdapterRegistry } from './adapters/chat-adapter.registry.js';
import type { ChatUpdatesView } from './adapters/chat-adapter.types.js';
import { ChatIntegrationsService } from './chat-integrations.service.js';
import type { CreateChatSubscriptionDto, UpdateChatSubscriptionDto } from './chat.dto.js';
import { UNFILTERED } from '../common/document-acl.js';
import { OPEN_TO_WORKSPACE } from '../permissions/access-scope.js';

/**
 * Rows younger than this are left for the next tick. `created_at` is stamped
 * at insert and committed a moment later, so a row stamped earlier can commit
 * after one stamped later; reading only rows past this lag is what keeps the
 * cursor from stepping over a row that was not visible yet.
 */
export const COMMIT_LAG_MS = 5_000;
/**
 * A tag lives in the graph, which a page's new revision reaches only once it
 * is indexed. A tagged rule therefore waits — holding its cursor — for an
 * unindexed revision, but not forever: past this, the row is judged on the
 * tags the graph has.
 */
export const INDEX_WAIT_MS = 10 * 60_000;
/** A rule whose bot was off for a week does not replay the week. */
export const BACKLOG_MS = 24 * 60 * 60_000;
/** Rows read per rule per tick; the rest is the next tick's. */
const MAX_ROWS = 500;
/** Lines in one message; the rest is counted in a closing line. */
export const MAX_ITEMS = 20;

type SubscriptionWithTarget = ChatSubscription & { binding: ChatChannelBinding & { integration: ChatIntegration } };

/** One line of a message, before it is translated. */
export interface UpdateItem {
  kind: ChatSubscriptionEventKind;
  documentId: string;
  title: string;
  /** `/documents/:id` or `/merge-requests/:id`, resolved against WEB_BASE_URL. */
  path: string;
}

/** The facts a finalized revision is judged on — see `chatEventKindFor`. */
interface RevisionFacts {
  status: string;
  onDefaultBranch: boolean;
  first: boolean;
  /** The revision a merge request landed; with a merged rule, the merge says it. */
  mergedByRequest: boolean;
}

/**
 * Channel notifications (issue #71, phase 3): a bound group told when pages
 * are published or updated and merge requests opened or merged.
 *
 * The feed is `activity_log`, read past a per-rule cursor, rather than the
 * Redis bus: pub/sub forgets whatever a restart missed, the table does not,
 * and a digest is then a query over rows that already exist rather than a
 * second store of them. Delivery is at most once — the cursor is moved by one
 * guarded update *before* the message goes out, so two sweeps (two API
 * processes, or a slow tick) never send the same rows, and a send the platform
 * refuses puts the cursor back for the next tick.
 *
 * Only titles and links ever reach the group. A bound group's members need
 * not all be workspace members, and the link enforces the ACL on click.
 */
@Injectable()
export class ChatSubscriptionsService {
  private readonly logger = new Logger(ChatSubscriptionsService.name);
  private readonly webBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    private readonly registry: ChatAdapterRegistry,
    private readonly integrations: ChatIntegrationsService,
    config: ConfigService<Env, true>,
  ) {
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true }).replace(/\/$/, '');
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async list(bindingId: string): Promise<ChatSubscriptionEntry[]> {
    const rows = await this.prisma.chatSubscription.findMany({ where: { bindingId }, orderBy: { createdAt: 'asc' } });
    return rows.map(toSubscriptionEntry);
  }

  async create(bindingId: string, dto: CreateChatSubscriptionDto, createdBy: string): Promise<ChatSubscriptionEntry> {
    const binding = await this.integrations.requireBinding(bindingId);
    await this.assertProject(binding.workspaceId, dto.projectId ?? null);
    const delivery = dto.delivery ?? 'instant';
    const digestMinutes = digestWindow(delivery, dto.digestMinutes ?? null);
    const row = await this.prisma.chatSubscription.create({
      data: {
        bindingId,
        workspaceId: binding.workspaceId,
        projectId: dto.projectId ?? null,
        tags: foldTags(dto.tags ?? []),
        eventKinds: [...new Set(dto.eventKinds)],
        delivery,
        digestMinutes,
        nextDueAt: digestMinutes ? new Date(Date.now() + digestMinutes * 60_000) : null,
        createdBy,
      },
    });
    return toSubscriptionEntry(row);
  }

  async update(id: string, dto: UpdateChatSubscriptionDto): Promise<ChatSubscriptionEntry> {
    const row = await this.require(id);
    if (dto.projectId !== undefined) await this.assertProject(row.workspaceId, dto.projectId);
    const delivery = dto.delivery ?? (row.delivery as ChatSubscriptionDelivery);
    const retimed = dto.delivery !== undefined || dto.digestMinutes !== undefined;
    const digestMinutes = retimed ? digestWindow(delivery, dto.digestMinutes ?? row.digestMinutes) : row.digestMinutes;
    const data: Prisma.ChatSubscriptionUpdateInput = {
      ...(dto.projectId !== undefined ? { projectId: dto.projectId } : {}),
      ...(dto.tags !== undefined ? { tags: foldTags(dto.tags) } : {}),
      ...(dto.eventKinds !== undefined ? { eventKinds: [...new Set(dto.eventKinds)] } : {}),
      // A new window starts now: switching to daily must not fire at once
      // because the last hourly digest was an hour ago.
      ...(retimed
        ? { delivery, digestMinutes, nextDueAt: digestMinutes ? new Date(Date.now() + digestMinutes * 60_000) : null }
        : {}),
    };
    return toSubscriptionEntry(await this.prisma.chatSubscription.update({ where: { id }, data }));
  }

  async remove(id: string): Promise<void> {
    await this.require(id);
    await this.prisma.chatSubscription.delete({ where: { id } });
  }

  private async require(id: string): Promise<ChatSubscription> {
    const row = await this.prisma.chatSubscription.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(t('error.chat.subscriptionNotFound', { id }));
    return row;
  }

  private async assertProject(workspaceId: string, projectId: string | null): Promise<void> {
    if (!projectId) return;
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
    if (!project || project.workspaceId !== workspaceId) {
      throw new BadRequestException(t('error.chat.projectNotInWorkspace', { id: projectId }));
    }
  }

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  /**
   * One tick: every rule that is due — instant rules always, digests once
   * their window has passed — on an enabled bot. A rule that fails is logged
   * and left for the next tick; it never stops the others.
   */
  async deliverDue(now = new Date()): Promise<number> {
    const due = await this.prisma.chatSubscription.findMany({
      where: {
        OR: [{ delivery: 'instant' }, { nextDueAt: { lte: now } }],
        binding: { integration: { enabled: true } },
      },
      include: { binding: { include: { integration: true } } },
      orderBy: { createdAt: 'asc' },
    });
    let sent = 0;
    for (const sub of due) {
      try {
        if (await this.deliver(sub, now)) sent++;
      } catch (e: unknown) {
        this.logger.warn({ msg: 'chat subscription delivery failed', subscriptionId: sub.id, error: String(e) });
      }
    }
    return sent;
  }

  /** Read past the cursor, claim what was read, then send it. True when a message went out. */
  async deliver(sub: SubscriptionWithTarget, now = new Date()): Promise<boolean> {
    const kinds = sub.eventKinds as ChatSubscriptionEventKind[];
    const tags = sub.tags as string[];
    const window = sub.digestMinutes ? sub.digestMinutes * 60_000 : null;
    const nextDueAt = window ? new Date(now.getTime() + window) : null;

    const rows = kinds.length ? await this.readPastCursor(sub, kinds, now) : [];
    const { items, through } = await this.select(sub, kinds, tags, rows, now);

    if (!through) {
      // Nothing readable: an instant rule simply waits; a digest whose first
      // row is still indexing stays due so the next tick retries, and an empty
      // window starts the next one.
      if (window && rows.length === 0) {
        await this.prisma.chatSubscription.updateMany({ where: { id: sub.id, nextDueAt: sub.nextDueAt }, data: { nextDueAt } });
      }
      return false;
    }

    // The claim. Whoever moves the cursor from where it was is the one sender.
    const claimed = await this.prisma.chatSubscription.updateMany({
      where: { id: sub.id, cursorAt: sub.cursorAt, cursorId: sub.cursorId },
      data: { cursorAt: through.createdAt, cursorId: through.id, ...(window ? { nextDueAt } : {}) },
    });
    if (claimed.count === 0 || items.length === 0) return false;

    const integration = sub.binding.integration;
    const ctx = this.integrations.context(integration);
    const locale = [sub.binding.locale, integration.locale].find(isLocale) ?? 'en';
    try {
      if (!ctx) throw new Error(t('error.chat.noEncryptionKey', undefined, locale));
      const view = await this.view(sub, items, locale);
      const adapter = this.registry.get(integration.kind);
      await adapter.postMessage(ctx, { chatId: sub.binding.externalChatId }, adapter.render(view));
      await this.prisma.chatSubscription.update({ where: { id: sub.id }, data: { lastDeliveredAt: now, lastError: null } });
      return true;
    } catch (e: unknown) {
      // Put the cursor back — guarded, so a rule edited or claimed again
      // meanwhile is left alone — and say why on the settings page.
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      await this.prisma.chatSubscription.updateMany({
        where: { id: sub.id, cursorAt: through.createdAt, cursorId: through.id },
        data: { cursorAt: sub.cursorAt, cursorId: sub.cursorId, ...(window ? { nextDueAt: sub.nextDueAt } : {}), lastError: message },
      });
      throw e;
    }
  }

  /**
   * Activity past the cursor, oldest first: `(created_at, id)` after the
   * cursor's, filtered in SQL by workspace, project and the actions the rule's
   * kinds are read from, never older than the backlog floor and never younger
   * than the commit lag.
   */
  private readPastCursor(sub: ChatSubscription, kinds: ChatSubscriptionEventKind[], now: Date): Promise<ActivityLog[]> {
    const floor = new Date(now.getTime() - BACKLOG_MS);
    return this.prisma.activityLog.findMany({
      where: {
        workspaceId: sub.workspaceId,
        ...(sub.projectId ? { projectId: sub.projectId } : {}),
        action: { in: chatActionsFor(kinds) },
        AND: [
          { createdAt: { gt: floor, lte: new Date(now.getTime() - COMMIT_LAG_MS) } },
          { OR: [{ createdAt: { gt: sub.cursorAt } }, { createdAt: sub.cursorAt, id: { gt: sub.cursorId } }] },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_ROWS,
    });
  }

  /**
   * Which of `rows` the rule reports, and the last row the cursor may pass.
   *
   * Rows are taken in order up to the first one that is not ready — a tagged
   * rule's revision still indexing — so the cursor stops before it rather than
   * skipping it. Everything up to there is consumed, reported or not: a row
   * on another branch, of another kind or for an untagged page is read once
   * and passed.
   */
  async select(
    sub: Pick<ChatSubscription, 'workspaceId'>,
    kinds: ChatSubscriptionEventKind[],
    tags: string[],
    rows: ActivityLog[],
    now: Date,
  ): Promise<{ items: UpdateItem[]; through: ActivityLog | null }> {
    if (rows.length === 0) return { items: [], through: null };
    const wanted = new Set(kinds);
    const revisions = await this.revisionFacts(rows, wanted.has('merge-request-merged'));
    const tagged = tags.length
      ? // Only narrows which activity rows match; who may read the digest is
        // the audience clamp on `docs` below.
        await this.graph.getDocumentIdsByTags(sub.workspaceId, tags.map((tag) => `tag:${tag}`), UNFILTERED)
      : null;

    let end = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const rev = rows[i].action === 'revision.finalized' ? revisions.get(rows[i].subjectId ?? '') : undefined;
      const indexing = rev && (rev.status === 'finalized' || rev.status === 'indexing');
      if (tagged && rev?.onDefaultBranch && indexing && now.getTime() - rows[i].createdAt.getTime() < INDEX_WAIT_MS) {
        end = i;
        break;
      }
    }
    const ready = rows.slice(0, end);
    if (ready.length === 0) return { items: [], through: null };

    const docIds = [...new Set(ready.map((r) => r.documentId).filter((id): id is string => !!id))];
    const docs = new Map(
      (
        await this.prisma.document.findMany({
          // A digest is posted into a chat whose readers no grant can vouch
          // for (#76), so it names only pages every member can open.
          where: { id: { in: docIds }, workspaceId: sub.workspaceId, archivedAt: null, ...OPEN_TO_WORKSPACE },
          select: { id: true, title: true },
        })
      ).map((d) => [d.id, d.title]),
    );

    // Newest wins per line: a page edited five times in a window is one
    // "updated", and a page published then edited is one "new page".
    const byKey = new Map<string, UpdateItem>();
    for (const row of ready) {
      if (!row.documentId || !docs.has(row.documentId)) continue;
      if (tagged && !tagged.has(row.documentId)) continue;
      const rev = row.action === 'revision.finalized' ? revisions.get(row.subjectId ?? '') : undefined;
      const kind = chatEventKindFor(row.action, rev ?? null);
      if (!kind || !wanted.has(kind)) continue;
      if (kind === 'page-updated' && rev?.mergedByRequest) continue;
      const pageTitle = docs.get(row.documentId)!;
      if (kind === 'page-published' || kind === 'page-updated') {
        const key = `page:${row.documentId}`;
        if (byKey.get(key)?.kind === 'page-published') continue;
        byKey.delete(key);
        byKey.set(key, { kind, documentId: row.documentId, title: pageTitle, path: `/documents/${row.documentId}` });
      } else {
        const metaTitle = (row.metadata as { title?: unknown } | null)?.title;
        byKey.set(`${kind}:${row.subjectId}`, {
          kind,
          documentId: row.documentId,
          title: typeof metaTitle === 'string' && metaTitle.trim() ? metaTitle : pageTitle,
          path: `/merge-requests/${row.subjectId}`,
        });
      }
    }
    return { items: [...byKey.values()], through: ready[ready.length - 1] };
  }

  /**
   * Branch, first-ness, status and merge provenance of every finalized
   * revision in `rows`, in three reads however many rows there are.
   */
  private async revisionFacts(rows: ActivityLog[], withMerges: boolean): Promise<Map<string, RevisionFacts>> {
    const ids = rows.filter((r) => r.action === 'revision.finalized' && r.subjectId).map((r) => r.subjectId!);
    if (ids.length === 0) return new Map();
    const revs = await this.prisma.documentRevision.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        documentId: true,
        branchId: true,
        status: true,
        branch: { select: { name: true } },
        document: { select: { defaultBranch: true } },
      },
    });
    // The earliest non-draft revision on each (page, branch): the one that
    // published it there.
    const earliest = await this.prisma.documentRevision.findMany({
      where: { documentId: { in: [...new Set(revs.map((r) => r.documentId))] }, status: { not: 'draft' } },
      orderBy: [{ finalizedAt: 'asc' }, { createdAt: 'asc' }],
      distinct: ['documentId', 'branchId'],
      select: { id: true, documentId: true, branchId: true },
    });
    const firstOf = new Map(earliest.map((r) => [`${r.documentId}:${r.branchId}`, r.id]));
    const merged = withMerges
      ? new Set(
          (
            await this.prisma.mergeRequest.findMany({ where: { mergedRevisionId: { in: ids } }, select: { mergedRevisionId: true } })
          ).map((m) => m.mergedRevisionId),
        )
      : new Set<string | null>();
    return new Map(
      revs.map((r) => [
        r.id,
        {
          status: r.status,
          // A legacy revision with no branch row belongs to the default branch.
          onDefaultBranch: !r.branchId || r.branch?.name === r.document.defaultBranch,
          first: firstOf.get(`${r.documentId}:${r.branchId}`) === r.id,
          mergedByRequest: merged.has(r.id),
        },
      ]),
    );
  }

  /** The message: one line for one event, a heading and a list for more. */
  async view(sub: Pick<ChatSubscription, 'projectId' | 'workspaceId' | 'delivery'>, items: UpdateItem[], locale: Locale): Promise<ChatUpdatesView> {
    const shown = items.slice(0, MAX_ITEMS);
    const lines = shown.map((i) => ({
      label: t(`chat.updates.kind.${i.kind}`, undefined, locale),
      title: i.title,
      url: `${this.webBaseUrl}${i.path}`,
    }));
    const single = items.length === 1 && sub.delivery === 'instant';
    let heading: string | null = null;
    if (!single) {
      const scope = sub.projectId
        ? (await this.prisma.project.findUnique({ where: { id: sub.projectId }, select: { name: true } }))?.name
        : (await this.prisma.workspace.findUnique({ where: { id: sub.workspaceId }, select: { name: true } }))?.name;
      heading = t(sub.delivery === 'digest' ? 'chat.updates.digest' : 'chat.updates.heading', { count: items.length, scope: scope ?? '' }, locale);
    }
    const rest = items.length - shown.length;
    return {
      kind: 'updates',
      heading,
      items: lines,
      more: rest > 0 ? t('chat.updates.more', { count: rest }, locale) : null,
    };
  }
}

/**
 * Tags as the graph keys them, without the `tag:` prefix: folded by
 * `normalizeEntityKey`, so `Billing`, `billing` and `tag:billing` are one.
 */
export function foldTags(tags: string[]): string[] {
  const folded = tags
    .map((tag) => normalizeEntityKey(tag).replace(/^tag:/, ''))
    .filter((tag) => tag.length > 0);
  return [...new Set(folded)];
}

/** A digest needs a window from the offered set; an instant rule has none. */
function digestWindow(delivery: ChatSubscriptionDelivery, minutes: number | null): number | null {
  if (delivery === 'instant') return null;
  if (!minutes) throw new BadRequestException(t('error.chat.digestWindowRequired'));
  return minutes;
}

function toSubscriptionEntry(row: ChatSubscription): ChatSubscriptionEntry {
  return {
    id: row.id,
    bindingId: row.bindingId,
    projectId: row.projectId,
    tags: row.tags as string[],
    eventKinds: row.eventKinds as ChatSubscriptionEventKind[],
    delivery: row.delivery as ChatSubscriptionDelivery,
    digestMinutes: (row.digestMinutes as ChatDigestMinutes | null) ?? null,
    lastDeliveredAt: row.lastDeliveredAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
