import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AnswerFeedback } from '@prisma/client';
import type {
  AnswerConfidence,
  AnswerFeedbackListEntry,
  AnswerFeedbackReason,
  AnswerFeedbackSummary,
  AnswerRating,
  AnswerSignalKind,
  AnswerSurface,
  FeedbackBacktestCase,
  ListAnswerFeedbackResponse,
} from '@knowledge/contracts';
import {
  ANSWER_FEEDBACK_REASONS,
  ANSWER_RATINGS,
  ANSWER_SIGNAL_KINDS,
  ANSWER_SURFACES,
  KNOWLEDGE_ISSUE_STATUSES,
  REJECTING_FEEDBACK_REASONS,
  feedbackCaseFromVote,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { t } from '../i18n/t.js';

const LIST_PAGE_SIZE = 50;
const LIST_PAGE_MAX = 200;
/** Rows one export reads, whatever the window — the bound the issue set. */
export const EXPORT_MAX_ROWS = 50_000;
const EXPORT_BATCH = 1_000;
const DEFAULT_WINDOW_DAYS = 30;
/** A report filed this long after a down-vote, by the same person, on a page it cited, is taken as that vote's report. */
export const REPORT_LINK_WINDOW_MS = 60 * 60 * 1_000;

export interface FeedbackListFilter {
  kind?: string;
  rating?: string;
  reason?: string;
  surface?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

/** A report whose merge request merged: the page answers the question now. */
export interface MergedFix {
  documentId: string;
  createdBy: string;
  createdAt: Date;
}

/**
 * The admin read side of answer feedback (docs/features/38, phase 5): the
 * Feedback tab's list and counts, and the labelled dataset `make backtest
 * --feedback` replays. Controller-free, in `FeedbackCoreModule`, because the
 * backtest script reaches it through the application context rather than
 * over HTTP — the export route and `--export-feedback` write the same lines.
 */
@Injectable()
export class FeedbackDatasetService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, filter: FeedbackListFilter): Promise<ListAnswerFeedbackResponse> {
    const limit = Math.min(Math.max(filter.limit ?? LIST_PAGE_SIZE, 1), LIST_PAGE_MAX);
    const where = this.whereFor(workspaceId, filter);
    const rows = await this.prisma.answerFeedback.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, limit);
    const titles = await this.titlesFor(page.flatMap((r) => citedIds(r)));
    return {
      workspaceId,
      entries: page.map((r) => toEntry(r, titles)),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  /** Grouped counts over the rows that exist — a `Promise.all` of two GROUP BYs, no table behind it. */
  async summary(workspaceId: string, range: { from?: string; to?: string }): Promise<AnswerFeedbackSummary> {
    const { from, to } = this.rangeFor(range);
    const [groups, issueGroups] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{ kind: string; surface: string; rating: string | null; reason: string | null; cited: boolean; count: bigint }>
      >`
        SELECT kind, surface, rating, reason,
               jsonb_array_length(cited_document_ids) > 0 AS cited,
               COUNT(*)::bigint AS count
        FROM answer_feedback
        WHERE workspace_id = ${workspaceId}::uuid AND created_at >= ${from} AND created_at <= ${to}
        GROUP BY 1, 2, 3, 4, 5`,
      this.prisma.knowledgeIssue.groupBy({
        by: ['status'],
        where: { workspaceId, createdAt: { gte: from, lte: to } },
        _count: { _all: true },
      }),
    ]);
    const votes = { up: 0, down: 0 };
    const signals = { 'low-confidence': 0, 'no-answer': 0 };
    const byReason = new Map<AnswerFeedbackReason, number>();
    const bySurface = new Map<AnswerSurface, number>();
    let datasetVotes = 0;
    for (const g of groups) {
      const n = Number(g.count);
      if (g.kind === 'vote') {
        if (g.rating === 'up') votes.up += n;
        else if (g.rating === 'down') votes.down += n;
        if (g.reason && (ANSWER_FEEDBACK_REASONS as readonly string[]).includes(g.reason)) {
          const r = g.reason as AnswerFeedbackReason;
          byReason.set(r, (byReason.get(r) ?? 0) + n);
        }
        if (g.cited && (g.rating === 'up' || (REJECTING_FEEDBACK_REASONS as readonly string[]).includes(g.reason ?? ''))) {
          datasetVotes += n;
        }
      } else if (g.kind === 'low-confidence' || g.kind === 'no-answer') {
        signals[g.kind] += n;
      }
      if ((ANSWER_SURFACES as readonly string[]).includes(g.surface)) {
        const s = g.surface as AnswerSurface;
        bySurface.set(s, (bySurface.get(s) ?? 0) + n);
      }
    }
    return {
      workspaceId,
      from: from.toISOString(),
      to: to.toISOString(),
      votes,
      signals,
      byReason: ANSWER_FEEDBACK_REASONS.map((reason) => ({ reason, count: byReason.get(reason) ?? 0 })).filter((x) => x.count > 0),
      bySurface: ANSWER_SURFACES.map((surface) => ({ surface, count: bySurface.get(surface) ?? 0 })).filter((x) => x.count > 0),
      issues: KNOWLEDGE_ISSUE_STATUSES.map((status) => ({
        status,
        count: issueGroups.find((g) => g.status === status)?._count._all ?? 0,
      })).filter((x) => x.count > 0),
      datasetVotes,
    };
  }

  /**
   * The labelled dataset, newest vote first, as an async stream so the export
   * route can write while it reads. Reads at most `EXPORT_MAX_ROWS` vote rows;
   * `onRead` reports how many were read so the caller can say when the bound
   * was hit. The merged fixes are loaded once up front — there are few — and
   * joined to votes in memory by `linkMergedFixes`.
   */
  async *cases(workspaceId: string, range: { from?: string; to?: string }): AsyncGenerator<FeedbackBacktestCase, { read: number; truncated: boolean }> {
    const { from, to } = this.rangeFor({ ...range, defaultFrom: 'all' });
    const fixes = await this.mergedFixes(workspaceId);
    let cursor: string | undefined;
    let read = 0;
    for (;;) {
      const take = Math.min(EXPORT_BATCH, EXPORT_MAX_ROWS - read);
      if (take <= 0) break;
      const rows = await this.prisma.answerFeedback.findMany({
        where: { workspaceId, kind: 'vote', createdAt: { gte: from, lte: to } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const page = rows.slice(0, take);
      read += page.length;
      for (const r of page) {
        const vote = voteOf(r);
        if (!vote) continue;
        const c = feedbackCaseFromVote(vote, linkMergedFixes(vote, r.createdBy, fixes));
        if (c) yield c;
      }
      if (rows.length <= take) return { read, truncated: false };
      cursor = page[page.length - 1].id;
    }
    return { read, truncated: true };
  }

  /** Reports that became a merged merge request, dismissed ones excluded. */
  private async mergedFixes(workspaceId: string): Promise<MergedFix[]> {
    const issues = await this.prisma.knowledgeIssue.findMany({
      where: { workspaceId, mergeRequestId: { not: null }, status: { not: 'dismissed' } },
      select: { documentId: true, createdBy: true, createdAt: true, mergeRequestId: true },
    });
    if (issues.length === 0) return [];
    const merged = await this.prisma.mergeRequest.findMany({
      where: { id: { in: issues.map((i) => i.mergeRequestId as string) }, status: 'merged' },
      select: { id: true },
    });
    const mergedIds = new Set(merged.map((m) => m.id));
    return issues
      .filter((i) => mergedIds.has(i.mergeRequestId as string))
      .map((i) => ({ documentId: i.documentId, createdBy: i.createdBy, createdAt: i.createdAt }));
  }

  private whereFor(workspaceId: string, f: FeedbackListFilter): Prisma.AnswerFeedbackWhereInput {
    const kind = oneOf('kind', f.kind, ANSWER_SIGNAL_KINDS);
    const rating = oneOf('rating', f.rating, ANSWER_RATINGS);
    const reason = oneOf('reason', f.reason, ANSWER_FEEDBACK_REASONS);
    const surface = oneOf('surface', f.surface, ANSWER_SURFACES);
    const from = f.from ? dateOf('from', f.from) : undefined;
    const to = f.to ? dateOf('to', f.to) : undefined;
    return {
      workspaceId,
      ...(kind ? { kind } : {}),
      ...(rating ? { rating } : {}),
      ...(reason ? { reason } : {}),
      ...(surface ? { surface } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    };
  }

  private rangeFor(r: { from?: string; to?: string; defaultFrom?: 'all' }): { from: Date; to: Date } {
    const to = r.to ? dateOf('to', r.to) : new Date();
    const from = r.from
      ? dateOf('from', r.from)
      : r.defaultFrom === 'all'
        ? new Date(0)
        : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1_000);
    if (from > to) throw new BadRequestException(t('error.feedback.invalidRange'));
    return { from, to };
  }

  private async titlesFor(documentIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(documentIds)];
    if (ids.length === 0) return new Map();
    const docs = await this.prisma.document.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } });
    return new Map(docs.map((d) => [d.id, d.title]));
  }
}

/**
 * The cited pages a down-vote's report got merged for: same person, a page the
 * vote cited, filed within `REPORT_LINK_WINDOW_MS` after the vote. The web
 * files that report straight from the thumbs-down, so the join is by who,
 * which page and when — not by parsing the report's text.
 */
export function linkMergedFixes(
  vote: { rating: AnswerRating; citedDocumentIds: readonly string[]; createdAt: string },
  createdBy: string,
  fixes: readonly MergedFix[],
): string[] {
  if (vote.rating !== 'down' || fixes.length === 0) return [];
  const votedAt = new Date(vote.createdAt).getTime();
  return fixes
    .filter((f) => {
      const filedAt = f.createdAt.getTime();
      return (
        f.createdBy === createdBy &&
        vote.citedDocumentIds.includes(f.documentId) &&
        filedAt >= votedAt &&
        filedAt - votedAt <= REPORT_LINK_WINDOW_MS
      );
    })
    .map((f) => f.documentId);
}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === '') return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new BadRequestException(t('error.feedback.invalidFilter', { name, value, allowed: allowed.join(', ') }));
  }
  return value as T;
}

function dateOf(name: string, value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(t('error.feedback.invalidDate', { name, value }));
  return d;
}

function citedIds(row: AnswerFeedback): string[] {
  const raw = row.citedDocumentIds;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

/** A vote row as the pure builder reads it; `null` for a row that is not a well-formed vote. */
function voteOf(row: AnswerFeedback) {
  if (row.kind !== 'vote' || (row.rating !== 'up' && row.rating !== 'down')) return null;
  if (!(ANSWER_SURFACES as readonly string[]).includes(row.surface)) return null;
  const reason = row.reason && (ANSWER_FEEDBACK_REASONS as readonly string[]).includes(row.reason) ? (row.reason as AnswerFeedbackReason) : null;
  return {
    workspaceId: row.workspaceId,
    query: row.query,
    surface: row.surface as AnswerSurface,
    rating: row.rating as AnswerRating,
    reason,
    citedDocumentIds: citedIds(row),
    createdAt: row.createdAt.toISOString(),
  };
}

function toEntry(row: AnswerFeedback, titles: Map<string, string>): AnswerFeedbackListEntry {
  const cited = citedIds(row);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind as AnswerSignalKind,
    surface: row.surface as AnswerSurface,
    rating: (row.rating as AnswerRating | null) ?? null,
    reason: (row.reason as AnswerFeedbackReason | null) ?? null,
    comment: row.comment,
    query: row.query,
    messageId: row.messageId,
    threadId: row.threadId,
    traceId: row.traceId,
    citedDocumentIds: cited,
    confidence: (row.confidence ?? null) as unknown as AnswerConfidence | null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    answerExcerpt: row.answerExcerpt,
    citedDocuments: cited.map((id) => ({ id, title: titles.get(id) ?? null })),
  };
}
