import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { AgentRun } from '@prisma/client';
import type { AgentFinding, AgentRunInput, Locale } from '@knowledge/contracts';
import { AgentFindingsService } from '../ai/agent-findings.service.js';
import { AccessService } from '../auth/access.service.js';
import { asLocale } from '../i18n/locale.js';
import { withLocale } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { COMPONENT_DRAFT_AGENT_KEY, COMPONENT_DRAFT_MAX_AGE_MS } from './component-drafts.service.js';

const SWEEP_INTERVAL_MS = 15_000;
const BATCH = 5;

/**
 * Opens a finished "Document this component" draft as a merge request (#236,
 * phase 5) — `ReportPublishSweeper`'s shape, for its reasons: opening a merge
 * request needs `MergeRequestsService`, which never loads in the worker, and
 * the worker generates while the API publishes. It doubles as recovery: a run
 * that finished while the API was down is opened when it comes back, inside
 * `COMPONENT_DRAFT_MAX_AGE_MS`.
 *
 * Each run is opened **at most once**, claimed by stamping `input.publishedAt`
 * in one guarded statement before anything is written. Component runs are
 * archaeologist runs with `input.component`; an excavation has none and is
 * never touched here.
 *
 * The merge request is attributed to the run's owner — the person who pressed
 * the button — whose role is checked again now: the run took a while, and
 * nothing is written on the strength of a check made before it. An owner who
 * can no longer edit leaves the draft on the run, unopened.
 */
@Injectable()
export class ComponentDraftSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ComponentDraftSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly findings: AgentFindingsService,
    private readonly access: AccessService,
  ) {}

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
      const since = new Date(Date.now() - COMPONENT_DRAFT_MAX_AGE_MS);
      const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM agent_runs
         WHERE agent_key = ${COMPONENT_DRAFT_AGENT_KEY}
           AND status = 'succeeded'
           AND finished_at >= ${since}
           AND input -> 'component' IS NOT NULL
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
          this.logger.warn(`Opening component draft ${id} failed: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Component draft sweep failed (non-fatal): ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async publish(run: AgentRun): Promise<void> {
    const input = (run.input ?? {}) as AgentRunInput;
    if (!input.component) return;
    const findings = Array.isArray(run.findings) ? (run.findings as unknown as AgentFinding[]) : [];
    const index = findings.findIndex((f) => !!f.draft && !f.mergeRequestId);
    if (index < 0) return;

    const principal = await this.access.principalFor(run.createdBy, asLocale(run.locale) as Locale);
    await this.access.requireRole(principal, run.workspaceId, 'editor');
    const place = input.component.projectId
      ? { projectId: input.component.projectId, parentId: input.component.parentId ?? null }
      : await this.destination(run.workspaceId, input.connectorId);
    if (!place) return;
    await this.findings.proposePage(run.workspaceId, run.id, index, principal, place);
  }

  /**
   * The connector's destination, else the workspace's first project at the
   * root — `createPage`'s fallback for a draft that was given no place.
   */
  private async destination(
    workspaceId: string,
    connectorId?: string,
  ): Promise<{ projectId: string; parentId: string | null } | null> {
    const connector = connectorId
      ? await this.prisma.connector.findFirst({ where: { id: connectorId, workspaceId }, select: { projectId: true, parentId: true } })
      : null;
    if (connector?.projectId) return { projectId: connector.projectId, parentId: connector.parentId };
    const first = await this.prisma.project.findFirst({ where: { workspaceId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    return first ? { projectId: first.id, parentId: null } : null;
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
