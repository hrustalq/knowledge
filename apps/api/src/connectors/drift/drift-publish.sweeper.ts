import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentRun } from '@prisma/client';
import { driftCheckMode, type AgentFinding, type AgentRunInput, type Locale } from '@knowledge/contracts';
import { AgentFindingsService } from '../../ai/agent-findings.service.js';
import { AccessService } from '../../auth/access.service.js';
import type { Env } from '../../config/env.js';
import { asLocale } from '../../i18n/locale.js';
import { withLocale } from '../../i18n/t.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { upsertPullRequestComment } from '../adapters/pull-request.js';
import { ConnectorsService } from '../connectors.service.js';
import { DRIFT_AGENT_KEY } from './drift-trigger.service.js';
import { driftCommentMarker, renderDriftComment, type DriftReportEntry } from './drift-report.js';

const SWEEP_INTERVAL_MS = 15_000;
const BATCH = 5;
/** A run older than this is history, not news — a restart after a long outage must not comment on last month. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Publishes a finished drift check (docs/features/35): the merge requests it
 * drafted, and the one comment on the pull request.
 *
 * API-side for the feature-17 reason, twice over. Opening a merge request
 * needs `MergeRequestsService`, which will not load in the worker; and a
 * comment on somebody's pull request is an outward write, which is exactly
 * what "the worker generates, the API publishes" keeps away from an unattended
 * run. It doubles as recovery: a run that finished while the API was down is
 * published when it comes back, inside `MAX_AGE_MS`.
 *
 * Both acts are attributed to the run's owner — the connector's owner, who
 * turned the check on. Proposals go through the same `AgentFindingsService`
 * the Propose button calls, with its per-finding claim, so a person pressing
 * Propose while this runs cannot open a second merge request either.
 *
 * Each run is published **at most once**: claimed by stamping
 * `input.publishedAt` in one guarded statement, before anything is written. A
 * comment that fails is logged, not retried — the next push to the branch
 * starts a new check and a new comment, and retrying a failing host every tick
 * would be the only thing this sweeper did.
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
         ORDER BY finished_at ASC
         LIMIT ${BATCH}
      `;
      for (const { id } of due) {
        if (!(await this.claim(id))) continue;
        const run = await this.prisma.agentRun.findUnique({ where: { id } });
        if (!run) continue;
        try {
          await withLocale(asLocale(run.locale), () => this.publish(run));
        } catch (error) {
          this.logger.warn(`Publishing drift check ${id} failed: ${(error as Error).message}`);
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
    const siblings = await this.prisma.agentRun.findMany({
      where: {
        workspaceId: run.workspaceId,
        agentKey: DRIFT_AGENT_KEY,
        id: { not: run.id },
        AND: [
          { input: { path: ['connectorId'], equals: row.id } },
          { input: { path: ['pullRequest', 'number'], equals: pr.number } },
        ],
      },
      select: { createdAt: true, findings: true },
    });
    if (siblings.some((s) => s.createdAt > run.createdAt)) return;

    const findings = Array.isArray(run.findings) ? (run.findings as unknown as AgentFinding[]) : [];
    const proposedBefore = await this.openProposals(siblings);

    const entries: DriftReportEntry[] = [];
    let principal: Awaited<ReturnType<AccessService['principalFor']>> | null = null;
    if (mode === 'propose' && findings.some((f) => f.draft)) {
      try {
        principal = await this.access.principalFor(run.createdBy, asLocale(run.locale) as Locale);
        await this.access.requireRole(principal, run.workspaceId, 'editor');
      } catch (error) {
        // An owner who can no longer edit cannot propose; the report still goes out.
        this.logger.warn(`drift proposals skipped for run ${run.id}: ${(error as Error).message}`);
        principal = null;
      }
    }

    for (const [index, finding] of findings.entries()) {
      const documentId = finding.documentIds[0];
      let mergeRequestId = finding.mergeRequestId ?? null;
      // The same page proposed by an earlier push and still open: point at that
      // merge request rather than opening a second one for one page.
      if (!mergeRequestId && documentId) mergeRequestId = proposedBefore.get(documentId) ?? null;
      if (!mergeRequestId && principal && finding.draft && documentId) {
        try {
          const res = await this.findings.propose(run.workspaceId, run.id, index, principal);
          mergeRequestId = res.mergeRequestId;
        } catch (error) {
          this.logger.warn(`drift proposal for "${finding.title}" failed: ${(error as Error).message}`);
        }
      }
      entries.push({ finding, mergeRequestId });
    }

    // A clean check on a pull request nobody was warned about stays quiet; a
    // clean check after a warning updates the comment to say it is resolved.
    const warnedBefore = siblings.some((s) => Array.isArray(s.findings) && s.findings.length > 0);
    if (entries.length === 0 && !warnedBefore) return;

    const body = renderDriftComment({
      webBaseUrl: this.webBaseUrl,
      connectorName: row.name,
      pullRequest: pr,
      entries,
    });
    const ctx = await this.connectors.contextFor(row, async () => undefined);
    await upsertPullRequestComment(ctx, pr.number, driftCommentMarker(row.id), body);
  }

  /** Page id → the still-open merge request an earlier check of this pull request opened for it. */
  private async openProposals(siblings: Array<{ findings: unknown }>): Promise<Map<string, string>> {
    const byMr = new Map<string, string>();
    for (const sibling of siblings) {
      for (const f of Array.isArray(sibling.findings) ? (sibling.findings as AgentFinding[]) : []) {
        if (f.mergeRequestId && f.documentIds[0]) byMr.set(f.mergeRequestId, f.documentIds[0]);
      }
    }
    if (byMr.size === 0) return new Map();
    const open = await this.prisma.mergeRequest.findMany({
      where: { id: { in: [...byMr.keys()] }, status: 'open' },
      select: { id: true },
    });
    return new Map(open.map((mr) => [byMr.get(mr.id)!, mr.id]));
  }

  /** Stamp `publishedAt` if nobody has. One statement, so two sweeps cannot both win. */
  private async claim(runId: string): Promise<boolean> {
    const affected = await this.prisma.$executeRaw`
      UPDATE agent_runs
         SET input = jsonb_set(COALESCE(input, '{}'::jsonb), '{publishedAt}', to_jsonb(${new Date().toISOString()}::text), true)
       WHERE id = ${runId}::uuid
         AND COALESCE(input ->> 'publishedAt', '') = ''
    `;
    return affected > 0;
  }
}
