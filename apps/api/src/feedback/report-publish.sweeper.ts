import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentRun } from '@prisma/client';
import type { AgentFinding, AgentRunInput, Locale } from '@knowledge/contracts';
import { AgentFindingsService } from '../ai/agent-findings.service.js';
import { AccessService } from '../auth/access.service.js';
import { asLocale } from '../i18n/locale.js';
import { t, withLocale } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { KnowledgeIssuesService, REPORT_AGENT_KEY } from './knowledge-issues.service.js';
import { Ticker } from '../common/ticker.js';

const SWEEP_INTERVAL_MS = 15_000;
const BATCH = 5;
/** A run older than this is history: a restart after a long outage must not act on last month's reports. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A claim older than this was taken by a sweep that died mid-publish, and is retaken (#809). */
const CLAIM_LEASE_MS = 10 * 60_000;
/** Retention runs once an hour, not every tick — a DELETE with a date predicate is not free on a large table. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const PURGE_BATCH = 500;
/** Batches one purge pass will delete before yielding to the next hour. */
const PURGE_MAX_BATCHES = 20;

/**
 * Publishes a finished report check (docs/features/38, phase 3) and purges
 * what retention says is too old.
 *
 * `DriftPublishSweeper`'s shape, for its reasons: opening a merge request
 * needs `MergeRequestsService`, which never loads in the worker, and "the
 * worker generates, the API publishes". It doubles as recovery — a run that
 * finished while the API was down is published when it comes back, inside
 * `MAX_AGE_MS`.
 *
 * Each run is claimed by stamping `input.publishedAt` in one guarded
 * statement before anything is written. The stamp is a lease (#809): a
 * process that died after the claim left the issue `checking` forever, so a
 * claim older than `CLAIM_LEASE_MS` is retaken while the issue is still
 * `checking` on this run. A publish that throws hands the issue back to
 * `open` at once. The drift sweeper's query excludes report runs and this one
 * excludes drift runs, so the two never race for the same row.
 *
 * What the verdict does to the issue (all guarded on it still being
 * `checking`, so a person who closed it meanwhile keeps their word):
 *
 * - a finding with a draft → `propose` as the run's owner → `proposed`;
 * - a finding without one (or an owner who cannot edit) → back to `open`, the
 *   verdict attached as evidence for the person who picks it up;
 * - no finding → the sentinel read the page and the report against each other
 *   and found nothing wrong → `resolved` by the run's owner;
 * - a failed run → back to `open`, with the error noted.
 */
@Injectable()
export class ReportPublishSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReportPublishSweeper.name);
  private readonly ticker = new Ticker(this.logger);
  private lastPurge = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly issues: KnowledgeIssuesService,
    private readonly findings: AgentFindingsService,
    private readonly access: AccessService,
    private readonly env: ConfigService,
  ) {}

  onModuleInit(): void {
    this.ticker.every(SWEEP_INTERVAL_MS, () => this.sweep());
  }

  onModuleDestroy(): void {
    this.ticker.stop();
  }

  async sweep(): Promise<void> {
    return this.ticker.exclusive(async () => {
      const since = new Date(Date.now() - MAX_AGE_MS);
      const expired = new Date(Date.now() - CLAIM_LEASE_MS);
      const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT r.id FROM agent_runs r
         WHERE r.agent_key = ${REPORT_AGENT_KEY}
           AND r.status IN ('succeeded', 'failed', 'cancelled')
           AND r.finished_at >= ${since}
           AND COALESCE(r.input ->> 'issueId', '') <> ''
           AND (
             NULLIF(r.input ->> 'publishedAt', '') IS NULL
             OR (
               NULLIF(r.input ->> 'publishedAt', '')::timestamptz < ${expired}
               AND EXISTS (SELECT 1 FROM knowledge_issues i WHERE i.agent_run_id = r.id AND i.status = 'checking')
             )
           )
         ORDER BY r.finished_at ASC
         LIMIT ${BATCH}
      `;
      for (const { id } of due) {
        if (!(await this.claim(id, expired))) continue;
        const run = await this.prisma.agentRun.findUnique({ where: { id } });
        if (!run) continue;
        try {
          await withLocale(asLocale(run.locale), () => this.publish(run));
        } catch (error) {
          const message = (error as Error).message;
          this.logger.warn(`Publishing report check ${id} failed: ${message}`);
          // Only `settleCheck` leaves `checking`; without this the issue waits out the lease.
          const issueId = ((run.input ?? {}) as AgentRunInput).issueId;
          if (issueId) {
            await withLocale(asLocale(run.locale), () =>
              this.issues.settleCheck(issueId, {
                status: 'open',
                note: t('knowledgeIssue.verdict.failed', { error: message.slice(0, 300) }),
              }),
            ).catch((settleError: unknown) =>
              this.logger.warn(`Report ${issueId} stays checking until the lease ends: ${String(settleError)}`),
            );
          }
        }
      }
      if (Date.now() - this.lastPurge >= PURGE_INTERVAL_MS) {
        this.lastPurge = Date.now();
        await this.purge();
      }
    });
  }

  async publish(run: AgentRun): Promise<void> {
    const input = (run.input ?? {}) as AgentRunInput;
    if (!input.issueId) return;
    const issue = await this.issues.forRun(input.issueId, run.workspaceId);
    if (!issue) return;

    if (run.status !== 'succeeded') {
      await this.issues.settleCheck(issue.id, {
        status: 'open',
        note: t('knowledgeIssue.verdict.failed', { error: (run.error ?? run.status).slice(0, 300) }),
      });
      return;
    }

    const findings = Array.isArray(run.findings) ? (run.findings as unknown as AgentFinding[]) : [];
    const index = findings.findIndex((f) => f.issueId === issue.id || f.documentIds[0] === issue.documentId);
    const finding = index >= 0 ? findings[index] : undefined;

    if (!finding) {
      await this.issues.settleCheck(issue.id, {
        status: 'resolved',
        note: t('knowledgeIssue.verdict.notStale', { summary: (run.summary ?? '').slice(0, 500) }),
        resolvedBy: run.createdBy,
      });
      return;
    }

    // An info finding is the no-model echo: nothing was judged, so nothing is
    // settled beyond handing the report back to a person.
    if (!finding.draft || finding.severity === 'info') {
      await this.issues.settleCheck(issue.id, { status: 'open', note: t('knowledgeIssue.verdict.noDraft', { detail: finding.detail.slice(0, 500) }) });
      return;
    }

    let mergeRequestId = finding.mergeRequestId ?? null;
    if (!mergeRequestId) {
      try {
        const principal = await this.access.principalFor(run.createdBy, asLocale(run.locale) as Locale);
        await this.access.requireRole(principal, run.workspaceId, 'editor');
        const res = await this.findings.propose(run.workspaceId, run.id, index, principal);
        mergeRequestId = res.mergeRequestId;
      } catch (error) {
        // A reporter who cannot edit (a viewer's report) or a proposal that
        // failed: the draft stays on the run for an editor's Propose button,
        // and the issue goes back to a person with the verdict attached.
        this.logger.warn(`Proposal from report ${issue.id} not opened: ${(error as Error).message}`);
        await this.issues.settleCheck(issue.id, { status: 'open', note: t('knowledgeIssue.verdict.drafted', { detail: finding.detail.slice(0, 500) }) });
        return;
      }
    }
    await this.issues.settleCheck(issue.id, {
      status: 'proposed',
      note: t('knowledgeIssue.verdict.drafted', { detail: finding.detail.slice(0, 500) }),
      mergeRequestId,
    });
  }

  /**
   * Retention (`ANSWER_FEEDBACK_RETENTION_DAYS`): feedback rows and closed
   * issues older than the window go, in batches, so one pass never holds a
   * lock across the whole table. Open issues are never purged — a report
   * nobody acted on is still a report.
   */
  async purge(): Promise<void> {
    const days = this.env.get<number>('ANSWER_FEEDBACK_RETENTION_DAYS') ?? 180;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let removed = 0;
    for (let i = 0; i < PURGE_MAX_BATCHES; i += 1) {
      const n = await this.prisma.$executeRaw`
        DELETE FROM answer_feedback
         WHERE id IN (SELECT id FROM answer_feedback WHERE created_at < ${cutoff} ORDER BY created_at ASC LIMIT ${PURGE_BATCH})
      `;
      removed += n;
      if (n < PURGE_BATCH) break;
    }
    for (let i = 0; i < PURGE_MAX_BATCHES; i += 1) {
      const n = await this.prisma.$executeRaw`
        DELETE FROM knowledge_issues
         WHERE id IN (
           SELECT id FROM knowledge_issues
            WHERE status IN ('resolved', 'dismissed') AND updated_at < ${cutoff}
            ORDER BY updated_at ASC LIMIT ${PURGE_BATCH}
         )
      `;
      removed += n;
      if (n < PURGE_BATCH) break;
    }
    if (removed > 0) this.logger.log(`Retention purged ${removed} feedback rows and closed issues older than ${days} days`);
  }

  /** Stamp `publishedAt` if nobody has, or their lease ran out. One statement, so two sweeps cannot both win. */
  private async claim(runId: string, expired: Date): Promise<boolean> {
    const affected = await this.prisma.$executeRaw`
      UPDATE agent_runs
         SET input = jsonb_set(COALESCE(input, '{}'::jsonb), '{publishedAt}', to_jsonb(${new Date().toISOString()}::text), true)
       WHERE id = ${runId}::uuid
         AND (
           NULLIF(input ->> 'publishedAt', '') IS NULL
           OR NULLIF(input ->> 'publishedAt', '')::timestamptz < ${expired}
         )
    `;
    return affected > 0;
  }
}
