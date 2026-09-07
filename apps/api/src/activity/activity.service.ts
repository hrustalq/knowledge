import { Injectable, Logger } from '@nestjs/common';
import type { ActivityEntry, ListActivityResponse } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsPublisher } from '../events/events.publisher.js';

export interface ActivityRecordInput {
  workspaceId: string;
  /** users.id, or the synthetic dev actor when omitted. */
  actor?: string;
  /** e.g. 'document.created', 'revision.finalized', 'merge-request.merged'. */
  action: string;
  documentId?: string;
  subjectId?: string;
  metadata?: Record<string, unknown>;
  /** Live data patching: changed entity fields, forwarded verbatim on the event bus (never persisted to the feed). */
  patch?: Record<string, unknown>;
}

/**
 * Feature 10 activity stream (docs/features/10): user-facing feed, distinct
 * from the Phase 5 security audit log. Recording is fire-and-forget — a feed
 * write must never fail the user's request — and every record is also
 * published on the live-event bus so feeds update in real time.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsPublisher,
  ) {}

  async record(input: ActivityRecordInput): Promise<void> {
    try {
      await this.prisma.activityLog.create({
        data: {
          workspaceId: input.workspaceId,
          actor: input.actor ?? 'dev',
          action: input.action,
          documentId: input.documentId ?? null,
          subjectId: input.subjectId ?? null,
          metadata: (input.metadata ?? {}) as object,
        },
      });
      await this.events.publish({
        type: input.action,
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        subjectId: input.subjectId,
        actor: input.actor ?? 'dev',
        title: typeof input.metadata?.title === 'string' ? input.metadata.title : undefined,
        ...(input.patch ? { patch: input.patch } : {}),
      });
    } catch (e) {
      this.logger.warn(`Activity record failed (non-fatal): ${(e as Error).message}`);
    }
  }

  async list(
    workspaceId: string,
    opts: { documentId?: string; subjectId?: string; limit?: number; cursor?: string } = {},
  ): Promise<ListActivityResponse> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = await this.prisma.activityLog.findMany({
      where: {
        workspaceId,
        ...(opts.documentId ? { documentId: opts.documentId } : {}),
        ...(opts.subjectId ? { subjectId: opts.subjectId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const docIds = [...new Set(page.map((r) => r.documentId).filter((id): id is string => !!id))];
    const docs = docIds.length
      ? await this.prisma.document.findMany({ where: { id: { in: docIds } }, select: { id: true, title: true } })
      : [];
    const titleById = new Map(docs.map((d) => [d.id, d.title]));

    const entries: ActivityEntry[] = page.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      actor: r.actor,
      action: r.action,
      documentId: r.documentId,
      documentTitle: r.documentId ? (titleById.get(r.documentId) ?? null) : null,
      subjectId: r.subjectId,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
    }));
    return { workspaceId, entries, nextCursor: hasMore ? page[page.length - 1].id : null };
  }
}
