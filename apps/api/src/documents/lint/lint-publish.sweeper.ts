import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { MergeRequestCheck, Prisma } from '@prisma/client';
import type { AgentFinding, MergeRequestCheckReason, ReviewThreadAnchor } from '@knowledge/contracts';
import { EventsPublisher } from '../../events/events.publisher.js';
import { asLocale } from '../../i18n/locale.js';
import { withLocale } from '../../i18n/t.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LINT_AGENT_KEY, countsOf, lintThreadBody, planLintThreads, type PriorLintThread } from './lint-check.js';

const SWEEP_INTERVAL_MS = 15_000;
const BATCH = 10;
/** A run older than this is history, not news — a restart after an outage must not comment on last week. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Settled = { id: string; runStatus: string; finishedAt: Date | null };

/**
 * Publishes a finished lint run onto its merge request (#74, phase 2): one
 * resolvable `source: 'ai'` thread per violation, anchored to its quote and
 * naming its rule — the review thread a person would have opened.
 *
 * API-side, the drift publisher's shape: the worker generates, the API
 * publishes, and that doubles as recovery for a run that finished while the
 * API was down. Each check is claimed **once**, by stamping `publishedAt` in
 * one guarded statement, before anything is written.
 *
 * Earlier checks' threads are reconciled rather than repeated (see
 * `planLintThreads`): a standing violation keeps its thread, a fixed one has
 * its thread resolved, and only lint threads are ever looked at — a person's
 * thread is never touched. Threads are written as the merge request's author
 * with `agent_key` set, the way an agent mention replies, so the reader sees
 * the linter speaking and the author is who it was billed to. No notification
 * is sent: the author would only be told about their own merge request.
 */
@Injectable()
export class LintPublishSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LintPublishSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsPublisher,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.prisma.$queryRaw<Settled[]>`
        SELECT c.id, r.status AS "runStatus", r.finished_at AS "finishedAt"
          FROM merge_request_checks c
          JOIN agent_runs r ON r.id = c.agent_run_id
         WHERE c.kind = 'lint'
           AND c.status = 'pending'
           AND c.published_at IS NULL
           AND r.status IN ('succeeded', 'failed', 'cancelled')
         ORDER BY r.finished_at ASC NULLS FIRST
         LIMIT ${BATCH}
      `;
      for (const settled of due) {
        if (!(await this.claim(settled.id))) continue;
        try {
          await this.publish(settled);
        } catch (error) {
          this.logger.warn(`Publishing lint check ${settled.id} failed: ${(error as Error).message}`);
          await this.finish(settled.id, { status: 'error', reason: 'run-failed' });
        }
      }
    } catch (error) {
      this.logger.warn(`Lint publish sweep failed (non-fatal): ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Stamp `publishedAt` if nobody has. One statement, so two sweeps cannot both win. */
  private async claim(checkId: string): Promise<boolean> {
    const claimed = await this.prisma.mergeRequestCheck.updateMany({
      where: { id: checkId, status: 'pending', publishedAt: null },
      data: { publishedAt: new Date() },
    });
    return claimed.count === 1;
  }

  private async publish(settled: Settled): Promise<void> {
    if (settled.runStatus !== 'succeeded') {
      await this.finish(settled.id, { status: 'error', reason: 'run-failed' });
      return;
    }
    if (!settled.finishedAt || settled.finishedAt.getTime() < Date.now() - MAX_AGE_MS) {
      await this.finish(settled.id, { status: 'skipped', reason: 'stale' });
      return;
    }

    const check = await this.prisma.mergeRequestCheck.findUniqueOrThrow({ where: { id: settled.id } });
    const [run, mr] = await Promise.all([
      this.prisma.agentRun.findUniqueOrThrow({ where: { id: check.agentRunId! } }),
      this.prisma.mergeRequest.findUniqueOrThrow({
        where: { id: check.mergeRequestId },
        include: { sourceBranch: { select: { headRevisionId: true } }, document: { select: { workspaceId: true } } },
      }),
    ]);
    const findings = (Array.isArray(run.findings) ? (run.findings as unknown as AgentFinding[]) : []).filter(
      (f) => f.kind === 'style' && f.ruleId,
    );
    const counts = countsOf(findings);
    const status = findings.length > 0 ? 'failed' : 'passed';

    // The branch moved on while the run worked: a newer check speaks for the
    // merge request, and threads about a head nobody is looking at would only
    // be resolved again by it. A merge request that closed keeps its verdict
    // and gets no threads — its discussion is read-only.
    if (mr.sourceBranch.headRevisionId !== check.headRevisionId) {
      await this.finish(check.id, { status: 'skipped', reason: 'superseded', counts: { ...counts } });
      return;
    }
    if (mr.status === 'open') {
      await withLocale(asLocale(run.locale), () => this.reconcile(check, run.createdBy, findings));
    }
    await this.finish(check.id, { status, reason: null, counts: { ...counts } });
    await this.events.publish({
      type: 'merge-request.updated',
      workspaceId: mr.document.workspaceId,
      documentId: mr.documentId,
      subjectId: mr.id,
    });
  }

  /** Earlier lint threads of the merge request against this check's findings, in one transaction. */
  private async reconcile(check: MergeRequestCheck, authorId: string, findings: AgentFinding[]): Promise<void> {
    const rows = await this.prisma.mergeRequestThread.findMany({
      where: { mergeRequestId: check.mergeRequestId, checkId: { not: null }, ruleId: { not: null } },
      select: { id: true, ruleId: true, anchor: true, resolved: true },
    });
    const prior: PriorLintThread[] = rows.map((r) => {
      const anchor = r.anchor as ReviewThreadAnchor | null;
      return { threadId: r.id, ruleId: r.ruleId, quote: anchor?.type === 'text' ? anchor.quote : null, resolved: r.resolved };
    });
    const plan = planLintThreads(prior, findings);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      for (const finding of plan.create) {
        const thread = await tx.mergeRequestThread.create({
          data: {
            mergeRequestId: check.mergeRequestId,
            resolvable: true,
            source: 'ai',
            anchorType: finding.anchor?.type ?? null,
            anchor: (finding.anchor ?? undefined) as Prisma.InputJsonValue | undefined,
            checkId: check.id,
            ruleId: finding.ruleId ?? null,
          },
        });
        await tx.mergeRequestComment.create({
          data: { threadId: thread.id, authorId, body: lintThreadBody(finding), agentKey: LINT_AGENT_KEY },
        });
      }
      // A standing violation's thread follows the newest check and head, so
      // the anchor resolves against the revision the reader is looking at.
      for (const { threadId, finding } of plan.keep) {
        await tx.mergeRequestThread.update({
          where: { id: threadId },
          data: { checkId: check.id, ...(finding.anchor ? { anchor: finding.anchor as Prisma.InputJsonValue } : {}) },
        });
      }
      if (plan.resolve.length) {
        // Resolved by nobody: the change fixed it, and no person did the resolving.
        await tx.mergeRequestThread.updateMany({
          where: { id: { in: plan.resolve }, resolved: false },
          data: { resolved: true, resolvedBy: null, resolvedAt: now },
        });
      }
    });
  }

  private async finish(
    checkId: string,
    fields: { status: string; reason: MergeRequestCheckReason | null; counts?: Prisma.InputJsonValue },
  ): Promise<void> {
    await this.prisma.mergeRequestCheck.update({ where: { id: checkId }, data: fields });
  }
}
