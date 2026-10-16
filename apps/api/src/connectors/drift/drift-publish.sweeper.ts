import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentRun } from '@prisma/client';
import {
  driftCheckMode,
  driftFlagPages,
  type AgentFinding,
  type AgentRunDetails,
  type AgentRunInput,
  type AgentRunPullRequest,
  type Locale,
} from '@knowledge/contracts';
import { AgentFindingsService } from '../../ai/agent-findings.service.js';
import { AccessService } from '../../auth/access.service.js';
import type { Env } from '../../config/env.js';
import { asLocale } from '../../i18n/locale.js';
import { withLocale } from '../../i18n/t.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { VerificationService } from '../../verification/verification.service.js';
import { upsertPullRequestComment } from '../adapters/pull-request.js';
import { ConnectorsService } from '../connectors.service.js';
import { flagNote, pagesToFlag } from './drift-flags.js';
import { DRIFT_AGENT_KEY } from './drift-trigger.service.js';
import { driftCommentMarker, renderDriftComment, type DriftReportEntry } from './drift-report.js';

const SWEEP_INTERVAL_MS = 15_000;
const BATCH = 5;
/** A run older than this is history, not news — a restart after a long outage must not comment on last month. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** What a sibling check of the same pull request contributes: when it ran, what it proposed, what it listed. */
type Sibling = { createdAt: Date; findings: unknown; details?: unknown };

/** The proposable part of a finding: a corrected body, or a `component.paths` edit (#236). */
const proposable = (f: AgentFinding) => !!f.draft || !!f.componentPaths?.length;

/** Whether a run listed any affected usage (#236) — a comment worth keeping current. */
const listsUsages = (details: unknown) => {
  const usages = (details as AgentRunDetails | null)?.affectedUsages;
  return !!usages && (usages.pages.length > 0 || usages.hiddenPages > 0 || usages.undocumentedTotal > 0);
};

/**
 * Publishes a finished drift check (docs/features/35): the merge requests it
 * drafted, the one comment on the pull request — and, since issue #66, the
 * flag on each page it found wrong.
 *
 * API-side for the feature-17 reason, twice over. Opening a merge request
 * needs `MergeRequestsService`, which will not load in the worker; and a
 * comment on somebody's pull request is an outward write, which is exactly
 * what "the worker generates, the API publishes" keeps away from an unattended
 * run. It doubles as recovery: a run that finished while the API was down is
 * published when it comes back, inside `MAX_AGE_MS`.
 *
 * All of it is attributed to the run's owner — the connector's owner, who
 * turned the check on. Proposals go through the same `AgentFindingsService`
 * the Propose button calls, with its per-finding claim, so a person pressing
 * Propose while this runs cannot open a second merge request either.
 *
 * Two passes, each claiming a run **at most once** in one guarded statement
 * before anything is written:
 *
 * - **Publish** (`input.publishedAt`): proposals, page flags (`requested`,
 *   docs/features/39), the comment.
 * - **Outdate** (`input.outdatedAt`): once `DriftTriggerService` has stamped
 *   `input.mergedAt`, the pages the newest check of that pull request flagged
 *   `requested` become `outdated` — unless somebody verified the page after
 *   the check started, cleared the request, or merged the proposed fix.
 *
 * Report checks (`input.issueId`, docs/features/38) share the agent and are
 * excluded here — `ReportPublishSweeper` claims those, so neither steals the
 * other's run. A comment that fails is logged, not retried — the next push to
 * the branch starts a new check and a new comment, and retrying a failing host
 * every tick would be the only thing this sweeper did.
 */
@Injectable()
export class DriftPublishSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DriftPublishSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly webBaseUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly findings: AgentFindingsService,
    private readonly access: AccessService,
    private readonly verification: VerificationService,
    config: ConfigService<Env, true>,
  ) {
    this.webBaseUrl = config.get('WEB_BASE_URL', { infer: true });
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    // Back-pressure: never a second sweep while one is in flight.
    if (this.running) return;
    this.running = true;
    try {
      const since = new Date(Date.now() - MAX_AGE_MS);
      const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM agent_runs
         WHERE agent_key = ${DRIFT_AGENT_KEY}
           AND status = 'succeeded'
           AND finished_at >= ${since}
           AND COALESCE(input ->> 'publishedAt', '') = ''
           AND COALESCE(input ->> 'issueId', '') = ''
         ORDER BY finished_at ASC
         LIMIT ${BATCH}
      `;
      for (const { id } of due) {
        if (!(await this.claim(id, 'publishedAt'))) continue;
        const run = await this.prisma.agentRun.findUnique({ where: { id } });
        if (!run) continue;
        try {
          await withLocale(asLocale(run.locale), () => this.publish(run));
        } catch (error) {
          this.logger.warn(`Publishing drift check ${id} failed: ${(error as Error).message}`);
        }
      }

      // Merged after the check: the flags move. Published runs only, so a
      // check and its merge arriving in one tick flag the page `requested`
      // above before this flips it; keyed on when it merged rather than when
      // it ran, because the pull request may have been open for weeks.
      const merged = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM agent_runs
         WHERE agent_key = ${DRIFT_AGENT_KEY}
           AND status = 'succeeded'
           AND COALESCE(input ->> 'publishedAt', '') <> ''
           AND COALESCE(input ->> 'mergedAt', '') <> ''
           AND COALESCE(input ->> 'outdatedAt', '') = ''
           AND (input ->> 'mergedAt')::timestamptz >= ${since}
         ORDER BY finished_at ASC
         LIMIT ${BATCH}
      `;
      for (const { id } of merged) {
        if (!(await this.claim(id, 'outdatedAt'))) continue;
        const run = await this.prisma.agentRun.findUnique({ where: { id } });
        if (!run) continue;
        try {
          await withLocale(asLocale(run.locale), () => this.outdate(run));
        } catch (error) {
          this.logger.warn(`Outdating pages for drift check ${id} failed: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Drift publish sweep failed (non-fatal): ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async publish(run: AgentRun): Promise<void> {
    const input = (run.input ?? {}) as AgentRunInput;
    const pr = input.pullRequest;
    if (!pr || !input.connectorId) return;

    const row = await this.prisma.connector.findUnique({ where: { id: input.connectorId } });
    // Turned off, or disabled, since the check was queued: say nothing.
    if (!row || !row.enabled || row.workspaceId !== run.workspaceId) return;
    const mode = driftCheckMode(row.config as Record<string, unknown>);
    if (mode === 'off') return;

    // Earlier checks of the same pull request: what they proposed, and whether
    // a newer one exists. A newer check publishes for itself — two comments
    // racing to describe two heads would leave the older one on top.
    const siblings = await this.siblings(run, row.id, pr.number);
    if (siblings.some((s) => s.createdAt > run.createdAt)) return;

    const findings = Array.isArray(run.findings) ? (run.findings as unknown as AgentFinding[]) : [];
    const proposedBefore = await this.proposals(siblings, 'open');

    const entries: DriftReportEntry[] = [];
    let principal: Awaited<ReturnType<AccessService['principalFor']>> | null = null;
    if (mode === 'propose' && findings.some(proposable)) {
      principal = await this.editorPrincipal(run, 'proposals');
    }

    for (const [index, finding] of findings.entries()) {
      const documentId = finding.documentIds[0];
      let mergeRequestId = finding.mergeRequestId ?? null;
      // The same page proposed by an earlier push and still open: point at that
      // merge request rather than opening a second one for one page.
      if (!mergeRequestId && documentId) mergeRequestId = proposedBefore.get(documentId) ?? null;
      if (!mergeRequestId && principal && proposable(finding) && documentId) {
        try {
          const res = await this.findings.propose(run.workspaceId, run.id, index, principal);
          mergeRequestId = res.mergeRequestId;
        } catch (error) {
          this.logger.warn(`drift proposal for "${finding.title}" failed: ${(error as Error).message}`);
        }
      }
      entries.push({ finding, mergeRequestId });
    }

    // The pages the check found wrong are asked for a look (docs/features/39)
    // before the comment goes out, so a host that refuses the comment does not
    // also silence the page.
    if (driftFlagPages(row.config as Record<string, unknown>)) await this.requestChecks(run, pr, findings);

    // A clean check on a pull request nobody was warned about stays quiet; a
    // clean check after a warning updates the comment to say it is resolved.
    // Affected usages (#236) are worth a comment on their own: they name the
    // docs downstream of a component change before anything has drifted.
    const affected = listsUsages(run.details) ? (run.details as AgentRunDetails).affectedUsages! : null;
    const warnedBefore = siblings.some(
      (s) => (Array.isArray(s.findings) && s.findings.length > 0) || listsUsages(s.details),
    );
    if (entries.length === 0 && !affected && !warnedBefore) return;

    const body = renderDriftComment({
      webBaseUrl: this.webBaseUrl,
      connectorName: row.name,
      pullRequest: pr,
      entries,
      affected,
    });
    const ctx = await this.connectors.contextFor(row, async () => undefined);
    await upsertPullRequestComment(ctx, pr.number, driftCommentMarker(row.id), body);
  }

  /**
   * `requested` on every page the check found wrong, attributed to the run's
   * owner with the pull request as the source. Any member may ask for a check,
   * so no role is required of the owner. Two guards, both inside `flag`: a page
   * verified after the check started has been looked at against something
   * newer than the check saw, and an `outdated` page is already worse than
   * asked-about. An archived page answers 409, which is logged and earned.
   */
  private async requestChecks(run: AgentRun, pr: AgentRunPullRequest, findings: AgentFinding[]): Promise<void> {
    for (const [documentId, finding] of pagesToFlag(findings)) {
      try {
        await this.verification.requestVerification(documentId, {
          actorId: run.createdBy,
          note: flagNote(finding, pr),
          source: { kind: 'drift', by: run.createdBy, runId: run.id, url: pr.url },
          unlessVerifiedAfter: run.createdAt,
          keepOutdated: true,
        });
      } catch (error) {
        this.logger.warn(`drift flag on page ${documentId} skipped: ${(error as Error).message}`);
      }
    }
  }

  /**
   * The pull request merged: the pages the newest check flagged `requested`
   * are now `outdated` (docs/features/39). Only the newest check speaks for the
   * pull request — an older one may name a page a later push fixed — and only
   * a page still `requested` moves: a person who verified it after the check,
   * or cleared the request, has already answered. A page whose proposed fix
   * was merged is right again and is left alone. `outdated` is an editor's
   * claim, so the owner's role is checked the way proposals check it.
   */
  private async outdate(run: AgentRun): Promise<void> {
    const input = (run.input ?? {}) as AgentRunInput;
    const pr = input.pullRequest;
    if (!pr || !input.connectorId) return;

    const row = await this.prisma.connector.findUnique({ where: { id: input.connectorId } });
    if (!row || !row.enabled || row.workspaceId !== run.workspaceId) return;
    const config = row.config as Record<string, unknown>;
    if (driftCheckMode(config) === 'off' || !driftFlagPages(config)) return;

    const findings = Array.isArray(run.findings) ? (run.findings as unknown as AgentFinding[]) : [];
    const pages = pagesToFlag(findings);
    if (pages.size === 0) return;

    const siblings = await this.siblings(run, row.id, pr.number);
    if (siblings.some((s) => s.createdAt > run.createdAt)) return;
    const fixed = await this.proposals([{ createdAt: run.createdAt, findings }, ...siblings], 'merged');

    const principal = await this.editorPrincipal(run, 'outdated flags');
    if (!principal) return;

    for (const [documentId, finding] of pages) {
      if (fixed.has(documentId)) continue;
      try {
        await this.verification.markOutdated(documentId, {
          actorId: run.createdBy,
          note: flagNote(finding, pr),
          source: { kind: 'drift', by: run.createdBy, runId: run.id, url: pr.url, at: input.mergedAt },
          unlessVerifiedAfter: run.createdAt,
          onlyIfFlag: 'requested',
        });
      } catch (error) {
        this.logger.warn(`drift outdated flag on page ${documentId} skipped: ${(error as Error).message}`);
      }
    }
  }

  /** Other checks of the same pull request on the same connector. */
  private siblings(run: AgentRun, connectorId: string, number: number): Promise<Sibling[]> {
    return this.prisma.agentRun.findMany({
      where: {
        workspaceId: run.workspaceId,
        agentKey: DRIFT_AGENT_KEY,
        id: { not: run.id },
        AND: [
          { input: { path: ['connectorId'], equals: connectorId } },
          { input: { path: ['pullRequest', 'number'], equals: number } },
        ],
      },
      select: { createdAt: true, findings: true, details: true },
    });
  }

  /**
   * The run's owner as an editor, or null with a log line. An owner who can
   * no longer edit cannot propose a change or declare a page wrong; the report
   * and the `requested` flags still go out.
   */
  private async editorPrincipal(run: AgentRun, what: string) {
    try {
      const principal = await this.access.principalFor(run.createdBy, asLocale(run.locale) as Locale);
      await this.access.requireRole(principal, run.workspaceId, 'editor');
      return principal;
    } catch (error) {
      this.logger.warn(`drift ${what} skipped for run ${run.id}: ${(error as Error).message}`);
      return null;
    }
  }

  /** Page id → the merge request in `status` that one of these checks opened for it. */
  private async proposals(runs: Sibling[], status: 'open' | 'merged'): Promise<Map<string, string>> {
    const byMr = new Map<string, string>();
    for (const sibling of runs) {
      for (const f of Array.isArray(sibling.findings) ? (sibling.findings as AgentFinding[]) : []) {
        if (f.mergeRequestId && f.documentIds[0]) byMr.set(f.mergeRequestId, f.documentIds[0]);
      }
    }
    if (byMr.size === 0) return new Map();
    const rows = await this.prisma.mergeRequest.findMany({
      where: { id: { in: [...byMr.keys()] }, status },
      select: { id: true },
    });
    return new Map(rows.map((mr) => [byMr.get(mr.id)!, mr.id]));
  }

  /** Stamp `key` if nobody has. One statement, so two sweeps cannot both win. */
  private async claim(runId: string, key: 'publishedAt' | 'outdatedAt'): Promise<boolean> {
    const affected = await this.prisma.$executeRaw`
      UPDATE agent_runs
         SET input = jsonb_set(COALESCE(input, '{}'::jsonb), ARRAY[${key}::text], to_jsonb(${new Date().toISOString()}::text), true)
       WHERE id = ${runId}::uuid
         AND COALESCE(input ->> ${key}, '') = ''
    `;
    return affected > 0;
  }
}
