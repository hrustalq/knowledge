import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type {
  KnowledgeEvent,
  ListNotificationSubscriptionsResponse,
  ListNotificationsResponse,
  NotificationCategory,
  NotificationEntry,
  NotificationPreferences,
  NotificationReason,
  NotificationSubjectType,
  NotificationSubscriptionEntry,
  NotificationUnreadCountResponse,
  SubscriptionState,
} from '@knowledge/contracts';
import {
  NOTIFICATION_CATEGORIES,
  notificationCategoryFor,
  notificationReasonRank,
  notificationRowCategory,
  typesForCategory,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { isDevActor } from '../activity/actor.js';
import { parseUserMentions } from '../documents/mentions.js';
import { t } from '../i18n/t.js';

/** A row the fan-out wrote, so the caller can push it to exactly one person. */
export interface NotificationDelivery {
  userId: string;
  notification: NotificationEntry;
}

export interface DirectNotifyInput {
  workspaceId: string;
  /** Who to tell. Filtered against workspace membership by the caller's own lookups. */
  userIds: string[];
  type: string;
  reason: NotificationReason;
  actor?: string | null;
  documentId?: string | null;
  subjectType?: NotificationSubjectType | null;
  subjectId?: string | null;
  title?: string | null;
  metadata?: Record<string, unknown>;
  /** Also start watching the subject — being pulled in means wanting the replies. */
  subscribe?: boolean;
}

/**
 * The per-person layer over the workspace-wide event bus (docs/features/22).
 *
 * ## Two doors
 *
 * **Fan-out** is implicit and has exactly one caller: `EventsPublisher.publish`,
 * the function every event in the system already passes through — including the
 * worker's direct publishes, which never touch `ActivityService`. That is the
 * same "single injection point" stance `GraphService` takes for the workspace
 * predicate, and it is why adding a notifiable event type later costs one entry
 * in `notificationCategoryFor` and no call-site changes at all.
 *
 * **Direct address** is explicit (`notify`, `notifyMentions`) and exists for the
 * three notifications that are addressed rather than broadcast: mentioned,
 * assigned, review requested. Those must reach you whether or not you watch the
 * subject, and their recipients are not on the bus — reviewer and assignee ids
 * live in `activity_log.metadata`, which `ActivityService.record` deliberately
 * does not forward onto the event.
 *
 * ## Nothing here may fail a user's request
 *
 * Every write path is wrapped and logged, the `ActivityService.record` contract.
 * A notification is a courtesy; losing one must never cost somebody their edit.
 *
 * The service takes only `PrismaService`, which is what lets `EventsModule`
 * import this without a `forwardRef`.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------ door one

  /**
   * Tell a subject's watchers that something happened to it.
   *
   * Returns one delivery per person written, so the publisher can push a
   * targeted `notification.created` frame to each of them and nobody else.
   */
  async fanOut(event: KnowledgeEvent): Promise<NotificationDelivery[]> {
    const category = notificationCategoryFor(event.type);
    // The gate that keeps this cheap: the great majority of events (every
    // revision lifecycle step, every settings write, every connector link)
    // cost one lookup in a code table and never reach the database.
    if (!category) return [];

    try {
      const recipients = new Map<string, NotificationReason>();
      const subject = watchSubjectOf(event);

      if (subject) {
        for (const [userId, reason] of await this.watchersOf(subject)) {
          claim(recipients, userId, reason);
        }
      }
      // Background work has no watchable subject: a run belongs to whoever
      // started it, and that is on the run row rather than on the event, which
      // is why a trigger-started run still reaches a person.
      const owner = await this.runOwnerOf(event);
      if (owner) claim(recipients, owner, 'participant');

      return await this.deliver(event, category, recipients, {
        workspaceId: event.workspaceId,
        subjectType: subject?.type ?? null,
        subjectId: subject?.id ?? event.subjectId ?? null,
      });
    } catch (e) {
      this.logger.warn(`Notification fan-out failed (non-fatal): ${(e as Error).message}`);
      return [];
    }
  }

  // ------------------------------------------------------------ door two

  /** Tell named people directly, bypassing the subject's watcher set. */
  async notify(input: DirectNotifyInput): Promise<NotificationDelivery[]> {
    // The reason decides here: a mention rides in on an ordinary
    // `*.comment.created`, and filing it under `comment` would let somebody who
    // muted comments miss being called into a discussion by name.
    const category = notificationRowCategory(input.type, input.reason);
    if (!category) return [];
    try {
      const recipients = new Map<string, NotificationReason>();
      for (const userId of new Set(input.userIds)) claim(recipients, userId, input.reason);

      if (input.subscribe && input.subjectType && input.subjectId) {
        for (const userId of recipients.keys()) {
          await this.ensureSubscription(
            input.workspaceId,
            userId,
            input.subjectType,
            input.subjectId,
            input.reason,
          );
        }
      }

      return await this.deliver(
        {
          type: input.type,
          workspaceId: input.workspaceId,
          documentId: input.documentId ?? undefined,
          subjectId: input.subjectId ?? undefined,
          title: input.title ?? undefined,
          actor: input.actor ?? undefined,
        },
        category,
        recipients,
        {
          workspaceId: input.workspaceId,
          subjectType: input.subjectType ?? null,
          subjectId: input.subjectId ?? null,
        },
        input.metadata,
      );
    } catch (e) {
      this.logger.warn(`Direct notify failed (non-fatal): ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * The people a comment body names, as notifications.
   *
   * Mentioned ids are resolved against `workspace_members` before anything is
   * written: the attribute is machine-written but the body is user-supplied, so
   * a hand-typed uuid from another tenant must notify nobody.
   */
  async notifyMentions(input: {
    workspaceId: string;
    body: string;
    userIds: string[];
    type: string;
    actor: string;
    documentId: string;
    subjectType: NotificationSubjectType;
    subjectId: string;
    title?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<NotificationDelivery[]> {
    if (input.userIds.length === 0) return [];
    try {
      const members = await this.prisma.workspaceMember.findMany({
        where: { workspaceId: input.workspaceId, userId: { in: input.userIds } },
        select: { userId: true },
      });
      const real = members.map((m) => m.userId);
      if (real.length === 0) return [];

      return await this.notify({
        workspaceId: input.workspaceId,
        userIds: real,
        type: input.type,
        reason: 'mention',
        actor: input.actor,
        documentId: input.documentId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        title: input.title ?? null,
        metadata: { ...input.metadata, mention: true },
        // Being called into a discussion is a reason to hear the rest of it.
        subscribe: true,
      });
    } catch (e) {
      this.logger.warn(`Mention notify failed (non-fatal): ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Somebody posted a comment: subscribe them to what they commented on, and
   * tell anyone they named.
   *
   * One method for both discussion surfaces because the two thread tables are
   * deliberate twins (docs/features/15) — a page comment and a review comment
   * differ in what they hang off, not in who should hear about them. The
   * watchers of the subject are not this method's business: they are reached by
   * the fan-out, off the `*.comment.created` event the caller already publishes.
   */
  async onCommentPosted(input: {
    workspaceId: string;
    /** The watchable thing: the page for a page comment, the MR for a review. */
    subjectType: NotificationSubjectType;
    subjectId: string;
    documentId: string;
    title?: string | null;
    body: string;
    actorId: string;
    /** 'document.comment.created' | 'merge-request.comment.created'. */
    type: string;
    metadata?: Record<string, unknown>;
    // Returns what it wrote so the caller can publish a live frame for it: this
    // service takes PrismaService and nothing else — the property that lets
    // EventsModule import NotificationsCoreModule without a forwardRef — so it
    // cannot announce its own rows. Callers hand these to
    // `EventsPublisher.announce`; before they did, a mention wrote an inbox row
    // and no frame, and the badge stayed stale until the next navigation.
  }): Promise<NotificationDelivery[]> {
    try {
      await this.ensureSubscriptionOnComment(
        input.workspaceId,
        input.actorId,
        input.subjectType,
        input.subjectId,
      );
      const mentioned = parseUserMentions(input.body).filter((id) => id !== input.actorId);
      if (mentioned.length === 0) return [];
      return await this.notifyMentions({
        workspaceId: input.workspaceId,
        body: input.body,
        userIds: mentioned,
        type: input.type,
        actor: input.actorId,
        documentId: input.documentId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        title: input.title ?? null,
        metadata: input.metadata,
      });
    } catch (e) {
      this.logger.warn(`onCommentPosted failed (non-fatal): ${(e as Error).message}`);
      return [];
    }
  }

  // ------------------------------------------------------------ delivery

  /**
   * Suppress, filter by preference, then write.
   *
   * Splitting this out is what keeps the two doors honest: a directed
   * notification and a fan-out end up under the same coalescing and the same
   * muted-category rule, so neither can become a way to bypass the other.
   */
  private async deliver(
    event: Pick<KnowledgeEvent, 'type' | 'workspaceId' | 'documentId' | 'subjectId' | 'title' | 'actor'>,
    category: NotificationCategory,
    recipients: Map<string, NotificationReason>,
    subject: { workspaceId: string; subjectType: NotificationSubjectType | null; subjectId: string | null },
    extraMetadata?: Record<string, unknown>,
  ): Promise<NotificationDelivery[]> {
    const actor = event.actor ?? null;
    // Nobody is told about their own action — except the AUTH_MODE=none actor.
    // Every request in that mode is the same dev principal, so suppressing it
    // would leave the inbox permanently empty and the feature untestable
    // without a bootstrapped key. Same accommodation the merge-request approval
    // gate makes for the same principal, and for the same reason.
    if (actor && !isDevActor(actor)) recipients.delete(actor);
    if (recipients.size === 0) return [];

    for (const userId of await this.mutedBy(subject.workspaceId, [...recipients.keys()], category)) {
      recipients.delete(userId);
    }
    if (recipients.size === 0) return [];

    const deliveries: NotificationDelivery[] = [];
    for (const [userId, reason] of recipients) {
      const row = await this.write({
        workspaceId: subject.workspaceId,
        userId,
        type: event.type,
        reason,
        actor,
        documentId: event.documentId ?? null,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        title: event.title ?? null,
        metadata: extraMetadata,
      });
      if (row) deliveries.push({ userId, notification: row });
    }
    return deliveries;
  }

  /**
   * Write one row, coalescing into an unread one that says the same thing.
   *
   * Five replies to a thread while somebody was away is one line, not five —
   * and coalescing is also what removes the ordering problem between the two
   * doors: a mentioned person who *also* watches the page ends with a single
   * row whose reason is `mention`, whichever door fired first.
   *
   * `updateMany` then insert, rather than an upsert: the natural key is
   * "(user, type, subject) among unread rows", which is a partial unique index
   * Prisma cannot express. A concurrent race can therefore duplicate a row at
   * worst — cosmetic, and it self-corrects as soon as either is read.
   */
  private async write(input: {
    workspaceId: string;
    userId: string;
    type: string;
    reason: NotificationReason;
    actor: string | null;
    documentId: string | null;
    subjectType: NotificationSubjectType | null;
    subjectId: string | null;
    title: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<NotificationEntry | null> {
    const key = coalesceKey(input);
    if (key) {
      const existing = await this.prisma.notification.findFirst({
        where: { userId: input.userId, type: input.type, subjectId: key, readAt: null },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        const previous = (existing.metadata ?? {}) as Record<string, unknown>;
        const count = typeof previous.count === 'number' ? previous.count + 1 : 2;
        const row = await this.prisma.notification.update({
          where: { id: existing.id },
          data: {
            // The strongest claim on the row keeps it: a mention that lands on
            // a page you were merely watching is a mention, not a page edit.
            reason:
              notificationReasonRank(input.reason) > notificationReasonRank(existing.reason)
                ? input.reason
                : existing.reason,
            actor: input.actor ?? existing.actor,
            title: input.title ?? existing.title,
            metadata: { ...previous, ...input.metadata, count } as object,
            // Bumped so a coalesced row rises back to the top of the inbox
            // rather than staying where the first of its kind landed.
            createdAt: new Date(),
          },
        });
        return toEntry(row);
      }
    }

    const created = await this.prisma.notification.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        type: input.type,
        reason: input.reason,
        actor: input.actor,
        documentId: input.documentId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        title: input.title,
        metadata: (input.metadata ?? {}) as object,
      },
    });
    return toEntry(created);
  }

  // ------------------------------------------------------------ recipients

  /**
   * Everybody watching this subject, or the project that contains it.
   *
   * Most specific wins: a row on the page itself decides, and only when there
   * is none does the containing project's row apply. Otherwise muting one noisy
   * page would be undone by watching its project, and explicitly watching one
   * page inside a muted project would be impossible.
   */
  private async watchersOf(
    subject: { type: NotificationSubjectType; id: string },
  ): Promise<Map<string, NotificationReason>> {
    const scopes: { type: NotificationSubjectType; id: string }[] = [subject];
    if (subject.type === 'document') {
      const project = await this.projectOf(subject.id);
      if (project) scopes.push({ type: 'project', id: project });
    }

    const rows = await this.prisma.notificationSubscription.findMany({
      where: { OR: scopes.map((s) => ({ subjectType: s.type, subjectId: s.id })) },
      select: { userId: true, subjectType: true, muted: true, reason: true },
    });

    const byUser = new Map<string, { muted: boolean; reason: string; specific: boolean }>();
    for (const row of rows) {
      const specific = row.subjectType !== 'project';
      const seen = byUser.get(row.userId);
      if (seen && seen.specific && !specific) continue;
      byUser.set(row.userId, { muted: row.muted, reason: row.reason, specific });
    }

    const out = new Map<string, NotificationReason>();
    for (const [userId, state] of byUser) {
      if (state.muted) continue;
      out.set(userId, reasonForSubscription(state.reason));
    }
    // The author of the page is not treated as an implicit watcher here: they
    // are subscribed when they create it, so unwatching their own page works.
    return out;
  }

  /** The owner of a background run, read off the run row the event names. */
  private async runOwnerOf(event: KnowledgeEvent): Promise<string | null> {
    const id = event.subjectId;
    if (!id) return null;
    if (event.type.startsWith('workflow-run.') || event.type.startsWith('workflow-node.')) {
      const run = await this.prisma.workflowRun.findUnique({
        where: { id },
        select: { createdBy: true },
      });
      return run?.createdBy ?? null;
    }
    if (event.type.startsWith('agent.run.')) {
      const run = await this.prisma.agentRun.findUnique({
        where: { id },
        select: { createdBy: true },
      });
      return run?.createdBy ?? null;
    }
    if (event.type.startsWith('import.')) {
      const job = await this.prisma.importJob.findUnique({
        where: { id },
        select: { createdBy: true },
      });
      return job?.createdBy ?? null;
    }
    if (event.type.startsWith('connector.run.')) {
      const run = await this.prisma.connectorRun.findUnique({
        where: { id },
        select: { actorId: true },
      });
      return run?.actorId ?? null;
    }
    return null;
  }

  /** Which of these people have switched this category off. */
  private async mutedBy(
    workspaceId: string,
    userIds: string[],
    category: NotificationCategory,
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await this.prisma.notificationPreference.findMany({
      where: { workspaceId, userId: { in: userIds } },
      select: { userId: true, mutedCategories: true },
    });
    return rows
      .filter((r) => asCategories(r.mutedCategories).includes(category))
      .map((r) => r.userId);
  }

  private async projectOf(documentId: string): Promise<string | null> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { projectId: true },
    });
    return doc?.projectId ?? null;
  }

  // ------------------------------------------------------------ subscriptions

  /**
   * Start watching unless the person has said otherwise.
   *
   * A muted row is left exactly as it is — that is the whole point of storing
   * it — and so is an existing watch, so involvement never rewrites the reason
   * somebody is following something.
   */
  async ensureSubscription(
    workspaceId: string,
    userId: string,
    subjectType: NotificationSubjectType,
    subjectId: string,
    reason: string,
  ): Promise<void> {
    try {
      const existing = await this.prisma.notificationSubscription.findUnique({
        where: { userId_subjectType_subjectId: { userId, subjectType, subjectId } },
        select: { id: true },
      });
      if (existing) return;
      await this.prisma.notificationSubscription.create({
        data: { workspaceId, userId, subjectType, subjectId, reason },
      });
    } catch (e) {
      // A P2002 here means somebody else's request created the same row a
      // moment ago, which is the outcome we wanted anyway.
      this.logger.debug(`ensureSubscription no-op: ${(e as Error).message}`);
    }
  }

  /** Auto-subscribe on involvement, honouring the person's own preference. */
  async ensureSubscriptionOnComment(
    workspaceId: string,
    userId: string,
    subjectType: NotificationSubjectType,
    subjectId: string,
  ): Promise<void> {
    const prefs = await this.preferences(workspaceId, userId);
    if (!prefs.autoWatchOnComment) return;
    await this.ensureSubscription(workspaceId, userId, subjectType, subjectId, 'participant');
  }

  async setSubscription(
    workspaceId: string,
    userId: string,
    subjectType: NotificationSubjectType,
    subjectId: string,
    state: SubscriptionState,
  ): Promise<ListNotificationSubscriptionsResponse> {
    await this.assertSubjectInWorkspace(workspaceId, subjectType, subjectId);

    if (state === 'default') {
      await this.prisma.notificationSubscription.deleteMany({
        where: { userId, subjectType, subjectId },
      });
    } else {
      const data = { workspaceId, userId, subjectType, subjectId, muted: state === 'muted' };
      await this.prisma.notificationSubscription.upsert({
        where: { userId_subjectType_subjectId: { userId, subjectType, subjectId } },
        // A person pressing Watch owns the row from then on, so the reason
        // becomes 'manual' even if involvement created it.
        update: { muted: data.muted, reason: 'manual' },
        create: { ...data, reason: 'manual' },
      });
    }
    return this.listSubscriptions(workspaceId, userId, { subjectType, subjectId });
  }

  async listSubscriptions(
    workspaceId: string,
    userId: string,
    filter: { subjectType?: NotificationSubjectType; subjectId?: string } = {},
  ): Promise<ListNotificationSubscriptionsResponse> {
    const rows = await this.prisma.notificationSubscription.findMany({
      where: {
        workspaceId,
        userId,
        ...(filter.subjectType ? { subjectType: filter.subjectType } : {}),
        ...(filter.subjectId ? { subjectId: filter.subjectId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const subscriptions: NotificationSubscriptionEntry[] = rows.map((r) => ({
      subjectType: r.subjectType as NotificationSubjectType,
      subjectId: r.subjectId,
      state: r.muted ? 'muted' : 'watching',
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    }));
    return { workspaceId, subscriptions };
  }

  /**
   * A subject must belong to the workspace the caller was authorised against.
   *
   * The guard checked `?workspaceId=`; without this a member of workspace A
   * could watch a page in workspace B by naming its id, and would then be told
   * its title on every edit.
   */
  private async assertSubjectInWorkspace(
    workspaceId: string,
    subjectType: NotificationSubjectType,
    subjectId: string,
  ): Promise<void> {
    const owner = await this.workspaceOfSubject(subjectType, subjectId);
    if (owner !== workspaceId) {
      throw new BadRequestException(t('error.notification.subjectNotInWorkspace'));
    }
  }

  private async workspaceOfSubject(
    subjectType: NotificationSubjectType,
    subjectId: string,
  ): Promise<string | null> {
    if (subjectType === 'document') {
      const row = await this.prisma.document.findUnique({
        where: { id: subjectId },
        select: { workspaceId: true },
      });
      return row?.workspaceId ?? null;
    }
    if (subjectType === 'project') {
      const row = await this.prisma.project.findUnique({
        where: { id: subjectId },
        select: { workspaceId: true },
      });
      return row?.workspaceId ?? null;
    }
    const row = await this.prisma.mergeRequest.findUnique({
      where: { id: subjectId },
      select: { document: { select: { workspaceId: true } } },
    });
    return row?.document.workspaceId ?? null;
  }

  // ------------------------------------------------------------ inbox

  async list(
    workspaceId: string,
    userId: string,
    opts: { unread?: boolean; category?: NotificationCategory; limit?: number; cursor?: string } = {},
  ): Promise<ListNotificationsResponse> {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const rows = await this.prisma.notification.findMany({
      where: {
        workspaceId,
        userId,
        ...(opts.unread ? { readAt: null } : {}),
        // Pushed into SQL rather than classified in Node: `typesForCategory`
        // inverts the classifier over the closed KNOWN_EVENT_TYPES vocabulary,
        // so the category stays a derived reading without costing an
        // over-fetch. `mention` is a reason, not a type — hence the branch.
        ...(opts.category === 'mention'
          ? { reason: 'mention' }
          : opts.category
            ? { type: { in: typesForCategory(opts.category) } }
            : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const { count, counts } = await this.unreadTallies(workspaceId, userId);

    return {
      workspaceId,
      entries: page.map(toEntry),
      nextCursor: hasMore ? page[page.length - 1].id : null,
      unreadCount: count,
      counts,
    };
  }

  async unreadCount(workspaceId: string, userId: string): Promise<NotificationUnreadCountResponse> {
    const { count, counts } = await this.unreadTallies(workspaceId, userId);
    return { workspaceId, count, counts };
  }

  /**
   * Unread totals, overall and per category.
   *
   * One `groupBy` over type plus one count of mentions, rather than a query per
   * category: the categories are a reading of the type, so the database only
   * has to tell us how many of each type are unread and the split happens here.
   * (The `merge-request` list's `counts` does the same thing for statuses.)
   */
  private async unreadTallies(
    workspaceId: string,
    userId: string,
  ): Promise<{ count: number; counts: Record<NotificationCategory, number> }> {
    const grouped = await this.prisma.notification.groupBy({
      by: ['type', 'reason'],
      where: { workspaceId, userId, readAt: null },
      _count: { _all: true },
    });

    const counts = emptyCounts();
    let count = 0;
    for (const row of grouped) {
      const n = row._count._all;
      count += n;
      // Grouped by reason as well as type so the split matches what each row
      // displays under: every row lands in exactly one badge, and the badges
      // sum to the total the bell shows.
      const category = notificationRowCategory(row.type, row.reason);
      if (category) counts[category] += n;
    }
    return { count, counts };
  }

  /** Mark rows read. Always scoped by `userId`, so nobody can clear another inbox. */
  async markRead(
    workspaceId: string,
    userId: string,
    opts: { ids?: string[]; all?: boolean; category?: NotificationCategory },
  ): Promise<{ updated: number; unreadCount: number }> {
    if (!opts.all && !opts.ids?.length) {
      throw new BadRequestException(t('error.notification.nothingToMark'));
    }
    const { count: updated } = await this.prisma.notification.updateMany({
      where: {
        workspaceId,
        userId,
        readAt: null,
        ...(opts.ids?.length ? { id: { in: opts.ids } } : {}),
        ...(opts.category === 'mention'
          ? { reason: 'mention' }
          : opts.category
            ? { type: { in: typesForCategory(opts.category) } }
            : {}),
      },
      data: { readAt: new Date() },
    });
    const { count } = await this.unreadTallies(workspaceId, userId);
    return { updated, unreadCount: count };
  }

  // ------------------------------------------------------------ preferences

  /** The person's overrides folded onto the code defaults; no row means defaults. */
  async preferences(workspaceId: string, userId: string): Promise<NotificationPreferences> {
    const row = await this.prisma.notificationPreference.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
    });
    return {
      workspaceId,
      mutedCategories: row ? asCategories(row.mutedCategories) : [],
      autoWatchOnComment: row?.autoWatchOnComment ?? true,
    };
  }

  async updatePreferences(
    workspaceId: string,
    userId: string,
    patch: { mutedCategories?: NotificationCategory[]; autoWatchOnComment?: boolean },
  ): Promise<NotificationPreferences> {
    const current = await this.preferences(workspaceId, userId);
    const next = {
      mutedCategories: patch.mutedCategories ?? current.mutedCategories,
      autoWatchOnComment: patch.autoWatchOnComment ?? current.autoWatchOnComment,
    };
    await this.prisma.notificationPreference.upsert({
      where: { userId_workspaceId: { userId, workspaceId } },
      update: { mutedCategories: next.mutedCategories as object, autoWatchOnComment: next.autoWatchOnComment },
      create: {
        userId,
        workspaceId,
        mutedCategories: next.mutedCategories as object,
        autoWatchOnComment: next.autoWatchOnComment,
      },
    });
    return { workspaceId, ...next };
  }
}

// --------------------------------------------------------------------------- helpers

/**
 * Which watchable thing an event is about.
 *
 * Merge-request events name the MR in `subjectId` (see
 * `MergeRequestsService.recordActivity`), and everything else that carries a
 * `documentId` is about that page — including `document.comment.*`, whose
 * `subjectId` is the thread. Watching is per page, never per thread: a thread
 * is a place inside a page, not something somebody would follow separately.
 */
function watchSubjectOf(
  event: KnowledgeEvent,
): { type: NotificationSubjectType; id: string } | null {
  if (event.type.startsWith('merge-request.')) {
    return event.subjectId ? { type: 'merge-request', id: event.subjectId } : null;
  }
  if (event.documentId) return { type: 'document', id: event.documentId };
  return null;
}

/**
 * The thing a coalesced row is about — what the reader would click.
 *
 * The subject, not the event: three edits to one page collapse into one row,
 * and so do four replies in one merge request. `null` disables coalescing for
 * a row that names nothing specific, which is safer than collapsing unrelated
 * events onto each other.
 */
function coalesceKey(input: { subjectId: string | null; documentId: string | null }): string | null {
  return input.subjectId ?? input.documentId;
}

/** How a subscription's origin reads as a notification reason. */
function reasonForSubscription(reason: string): NotificationReason {
  return reason === 'author' || reason === 'participant' ? reason : 'watching';
}

/** Keep the strongest claim when two rules name the same person. */
function claim(
  into: Map<string, NotificationReason>,
  userId: string,
  reason: NotificationReason,
): void {
  const seen = into.get(userId);
  if (!seen || notificationReasonRank(reason) > notificationReasonRank(seen)) {
    into.set(userId, reason);
  }
}

function emptyCounts(): Record<NotificationCategory, number> {
  return Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, 0])) as Record<
    NotificationCategory,
    number
  >;
}

/** A Json column read back as a category list, dropping anything unrecognised. */
function asCategories(value: unknown): NotificationCategory[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is NotificationCategory =>
    (NOTIFICATION_CATEGORIES as readonly unknown[]).includes(v),
  );
}

interface NotificationRow {
  id: string;
  workspaceId: string;
  type: string;
  reason: string;
  actor: string | null;
  documentId: string | null;
  subjectType: string | null;
  subjectId: string | null;
  title: string | null;
  metadata: unknown;
  readAt: Date | null;
  createdAt: Date;
}

function toEntry(row: NotificationRow): NotificationEntry {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type,
    category: notificationRowCategory(row.type, row.reason),
    reason: row.reason,
    actor: row.actor,
    documentId: row.documentId,
    subjectType: (row.subjectType as NotificationSubjectType | null) ?? null,
    subjectId: row.subjectId,
    title: row.title,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
